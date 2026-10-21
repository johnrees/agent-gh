import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failure } from "../src/failure.ts";
import type { GraphJson } from "../src/graph.ts";
import { graphLoop, type LoopIo, MAX_BACKOFF, writePage } from "../src/graph-loop.ts";
import { FIXTURE } from "./graph-fixture.ts";

/** A loop over a real directory, a fake clock and sleep, and reads that fail where `fails` says. */
const harness = (fails: (pass: number) => unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "graph-loop-"));
  const out = join(dir, "graph.html");
  const events: string[] = [];
  let clock = 0;
  let reads = 0;
  const io: LoopIo = {
    read: async () => {
      const pass = reads++;
      events.push(`read ${pass} at ${clock}`);
      const error = fails(pass);
      if (error !== undefined) throw error;
      return { ...FIXTURE, fetched_at: `pass ${pass}` } as GraphJson;
    },
    write: (path, text) => {
      events.push(`write ${path.slice(dir.length + 1)}`);
      writeFileSync(path, text);
    },
    rename: (from, to) => {
      // Mid-write, the page on disk is still the last whole one.
      events.push(`rename ${from.slice(dir.length + 1)} -> ${to.slice(dir.length + 1)} (out held ${safeRead(out)})`);
      renameSync(from, to);
    },
    sleep: async (ms) => {
      clock += ms / 1000;
    },
    log: (line) => events.push(`log ${line}`),
    tag: "4242",
  };
  const safeRead = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "nothing";
    }
  };
  return { dir, out, events, io, page: (json: GraphJson) => `page of ${json.fetched_at}`, read: () => safeRead(out) };
};

test("a page is written to a temporary file beside --out, then renamed over it", () => {
  const { dir, out, events, io, read } = harness(() => undefined);
  writePage(io, out, "one");
  writePage(io, out, "two");
  expect(read()).toBe("two");
  expect(events).toEqual([
    "write .graph.html.4242.tmp", "rename .graph.html.4242.tmp -> graph.html (out held nothing)",
    "write .graph.html.4242.tmp", "rename .graph.html.4242.tmp -> graph.html (out held one)",
  ]);
  expect(readdirSync(dir)).toEqual(["graph.html"]);
});

test("--every writes at once and each interval; a failed read logs one line, keeps the last page, backs off, and the next pass recovers", async () => {
  const { dir, out, events, io, page, read } = harness((pass) => (pass === 1 ? new Failure("reading the graph", "HTTP 502 from POST /graphql") : undefined));
  await graphLoop(io, { out, every: 60, page }, 3);
  expect(events).toEqual([
    "read 0 at 0", "write .graph.html.4242.tmp", "rename .graph.html.4242.tmp -> graph.html (out held nothing)",
    "read 1 at 60", `log agent-gh: reading the graph failed: HTTP 502 from POST /graphql; keeping ${out} as it is, next read in 120 s`,
    "read 2 at 180", "write .graph.html.4242.tmp", "rename .graph.html.4242.tmp -> graph.html (out held page of pass 0)",
  ]);
  expect(read()).toBe("page of pass 2");
  expect(readdirSync(dir)).toEqual(["graph.html"]);
});

test("reads that keep failing double the wait up to five minutes, never exit, and never write a page", async () => {
  const { dir, out, events, io, page } = harness(() => new TypeError("fetch failed: secret detail"));
  await graphLoop(io, { out, every: 60, page }, 6);
  expect(events.filter((event) => event.startsWith("read"))).toEqual(["read 0 at 0", "read 1 at 120", "read 2 at 360", "read 3 at 660", "read 4 at 960", "read 5 at 1260"]);
  expect(events.filter((event) => event.startsWith("log"))[0]).toBe(`log agent-gh: unexpected TypeError; keeping ${out} as it is, next read in 120 s`);
  expect(events.at(-1)).toContain(`next read in ${MAX_BACKOFF} s`);
  expect(readdirSync(dir)).toEqual([]);
});

test("an interval past five minutes is not shortened by a failure", async () => {
  const { out, events, io, page } = harness((pass) => (pass === 0 ? new Failure("reading the graph", "GitHub refused the token (HTTP 401)") : undefined));
  await graphLoop(io, { out, every: 600, page }, 3);
  expect(events.filter((event) => event.startsWith("read"))).toEqual(["read 0 at 0", "read 1 at 600", "read 2 at 1200"]);
});
