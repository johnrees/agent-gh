/**
 * `agent-gh notify`'s pure decisions: which thread a reference names, the
 * session a notify records, its id, and its text. notify-run.ts reads and
 * writes GitHub. The marker format is threads.ts's, which agent-threads reads.
 */
import { createHash } from "node:crypto";
import { Failure } from "./failure.ts";
import type { Env } from "./harness.ts";
import { parseRepo, type Repo, slug } from "./repo.ts";
import { notifyMarker, type Severity } from "./threads.ts";

const STAGE = "notifying";

/** An issue or pull request: GitHub numbers both alike, and comments on both through the issues API. */
export type ThreadRef = { readonly repo: Repo; readonly number: number };

/** `owner/repo#N`: how GitHub links a thread from anywhere. */
export const threadName = (ref: ThreadRef): string => `${slug(ref.repo)}#${ref.number}`;

export const sameThread = (a: ThreadRef, b: ThreadRef): boolean => a.number === b.number && slug(a.repo).toLowerCase() === slug(b.repo).toLowerCase();

/**
 * `N`, `#N`, `owner/repo#N`, or a github.com issue or pull request URL;
 * a bare number is in `here`, the clone's repository. Undefined otherwise.
 */
export const parseThreadRef = (value: string, here: Repo | undefined): ThreadRef | undefined => {
  const local = /^#?(\d+)$/.exec(value);
  if (local) return here === undefined ? undefined : { repo: here, number: Number(local[1]) };
  const named = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(value) ?? /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#]\S*)?$/i.exec(value);
  const repo = named === null ? undefined : parseRepo(named[1] as string);
  return repo === undefined ? undefined : { repo, number: Number((named as RegExpExecArray)[2]) };
};

const SESSION = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The harness session posting, as `<harness>:<id>`, so a watcher can tell its
 * own session's comments from another's; undefined when the harness does not
 * say (opencode) or says something unexpected.
 */
export const sessionId = (env: Env): string | undefined => {
  const value =
    env.CLAUDE_CODE_SESSION_ID ? `claude:${env.CLAUDE_CODE_SESSION_ID}`
    : env.CODEX_THREAD_ID ? `codex:${env.CODEX_THREAD_ID}`
    : env.CODEX_SESSION_ID ? `codex:${env.CODEX_SESSION_ID}`
    : env.PI_SESSION_ID ? `pi:${env.PI_SESSION_ID}`
    : undefined;
  return value !== undefined && SESSION.test(value) ? value : undefined;
};

/**
 * Refuses text an agent posts that is empty or carries a marker of its own:
 * a forged `agent-notify` in a reply would make the reply need an answer,
 * which is how two agents start a loop.
 */
export const checkedText = (stage: "notifying" | "replying", what: string, value: string): string => {
  const text = value.trim();
  if (text === "") throw new Failure(stage, `${what} is empty`);
  if (/<!--\s*agent-/i.test(text)) throw new Failure(stage, `${what} holds an agent-gh marker (<!-- agent-...); only agent-gh writes those`);
  return text;
};

/**
 * A notify's id: 16 hex digits of the SHA-256 of the thread it goes to and its
 * text with whitespace collapsed. The same finding sent to the same thread
 * twice has the same id, whatever its severity or source, and is refused.
 */
export const notifyId = (target: ThreadRef, text: string): string =>
  createHash("sha256").update(`${threadName(target).toLowerCase()}\n${text.replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 16);

/** The notify severities that need an answer; P3 never does, so it is no notify. */
export const NOTIFY_SEVERITIES: readonly Severity[] = ["P0", "P1", "P2"];

export const checkedSeverity = (value: string | undefined): Severity => {
  if (value === "P3") throw new Failure(STAGE, "a P3 needs no answer, so it is not a notify; post it as a plain comment (`gh issue comment` or `gh pr comment`)");
  if (!NOTIFY_SEVERITIES.includes(value as Severity)) throw new Failure(STAGE, "--severity must be P0, P1, or P2");
  return value as Severity;
};

/** The notify comment: its marker, the severity and the backlink to the thread it came from, the text, and how to answer. */
export const notifyBody = (input: { readonly id: string; readonly severity: Severity; readonly session: string | undefined; readonly from: ThreadRef; readonly text: string }): string =>
  [
    notifyMarker({ v: 1, id: input.id, severity: input.severity, ...(input.session === undefined ? {} : { session: input.session }) }),
    `**${input.severity}** from ${threadName(input.from)}:`,
    "",
    input.text,
    "",
    `Answer with \`agent-gh reply ${input.id} --applied <sha>\` or \`agent-gh reply ${input.id} --declined "<why>"\`.`,
  ].join("\n");
