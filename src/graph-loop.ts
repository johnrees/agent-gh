/**
 * `agent-gh graph --html --out <file> [--every <seconds>]`: writes the page
 * through a temporary file beside it and a rename, so a reload never sees
 * half a page; with `every`, again each interval until interrupted. A failed
 * read logs one line, keeps the last good page, and backs off.
 */
import { basename, dirname, join } from "node:path";
import { Failure } from "./failure.ts";
import type { GraphJson } from "./graph.ts";

/** The longest wait after failed reads, in seconds. */
export const MAX_BACKOFF = 300;

export type LoopIo = {
  /** One read of the graph, its token minted for this pass. */
  readonly read: () => Promise<GraphJson>;
  readonly write: (path: string, text: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** A suffix unique to this process, so two loops on one file never share a temporary file. */
  readonly tag: string;
};

/** Writes `text` to `out` through a temporary file beside it. */
export const writePage = (io: Pick<LoopIo, "write" | "rename" | "tag">, out: string, text: string): void => {
  const temporary = join(dirname(out), `.${basename(out)}.${io.tag}.tmp`);
  io.write(temporary, text);
  io.rename(temporary, out);
};

/** Why a pass failed, in one line: a Failure's own words, else the error's name only. */
const reason = (error: unknown): string => (error instanceof Failure ? error.message : `unexpected ${error instanceof Error ? error.name : "error"}`);

/**
 * Writes at once, then every `every` seconds; `passes` bounds it for a test.
 * After a failed read the wait doubles, up to five minutes (never below the
 * interval), and the next good read restores it. A page that cannot be drawn
 * (an unknown milestone) or written ends the loop.
 */
export const graphLoop = async (io: LoopIo, options: { readonly out: string; readonly every: number; readonly page: (json: GraphJson) => string }, passes = Number.POSITIVE_INFINITY): Promise<void> => {
  let wait = options.every;
  for (let pass = 0; pass < passes; pass++) {
    if (pass > 0) await io.sleep(wait * 1000);
    let json: GraphJson;
    try {
      json = await io.read();
    } catch (error) {
      wait = Math.max(options.every, Math.min(wait * 2, MAX_BACKOFF));
      io.log(`agent-gh: ${reason(error)}; keeping ${options.out} as it is, next read in ${wait} s`);
      continue;
    }
    writePage(io, options.out, options.page(json));
    wait = options.every;
  }
};
