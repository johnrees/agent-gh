/**
 * `agent-gh reply`'s pure decisions: what an address names, and the reply's
 * text. reply-run.ts finds the finding or notify on GitHub, answers it, and
 * resolves its review thread.
 */
import { Failure } from "./failure.ts";
import { checkedText } from "./notify.ts";
import { parseRepo, type Repo } from "./repo.ts";
import { inert, parseFinding } from "./review.ts";
import { replyMarker } from "./threads.ts";

const STAGE = "replying";

/**
 * What `reply` answers:
 * - `id`: a review finding's id (as `review full` prints it, and its marker
 *   carries) or a notify's, looked up on the pull request;
 * - `comment`: an inline review comment's URL (`#discussion_r<id>` or the
 *   files view's `#r<id>`), any comment in its thread;
 * - `thread`: a review thread's node id (`PRRT_...`);
 * - `review`: a review's URL (`#pullrequestreview-<id>`), for findings in its body;
 * - `issueComment`: a conversation comment's URL (`#issuecomment-<id>`), such as a notify.
 */
export type Address =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "comment"; readonly repo: Repo; readonly number: number; readonly commentId: number }
  | { readonly kind: "thread"; readonly node: string }
  | { readonly kind: "review"; readonly repo: Repo; readonly number: number; readonly reviewId: number }
  | { readonly kind: "issueComment"; readonly repo: Repo; readonly number: number; readonly commentId: number };

const URL_FORM = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)(?:\/(?:files|changes))?#(discussion_r|r|pullrequestreview-|issuecomment-)(\d+)$/i;

export const ADDRESS_FORMS = "a finding or notify id, a review comment's, review's, or comment's URL, or a review thread's id (PRRT_...)";

export const parseAddress = (value: string): Address | undefined => {
  if (/^[0-9a-f]{8,64}$/.test(value)) return { kind: "id", id: value };
  if (/^PRRT_[A-Za-z0-9_-]{1,100}$/.test(value)) return { kind: "thread", node: value };
  const url = URL_FORM.exec(value);
  const repo = url === null ? undefined : parseRepo(url[1] as string);
  if (url === null || repo === undefined) return undefined;
  const [kind, number, id] = [(url[4] as string).toLowerCase(), Number(url[3]), Number(url[5])];
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(id)) return undefined;
  const pull = (url[2] as string).toLowerCase() === "pull";
  if (kind === "issuecomment-") return { kind: "issueComment", repo, number, commentId: id };
  if (!pull) return undefined;
  return kind === "pullrequestreview-" ? { kind: "review", repo, number, reviewId: id } : { kind: "comment", repo, number, commentId: id };
};

/** How the finding was settled: fixed in a commit, or declined for a reason. */
export type Outcome = { readonly applied: string } | { readonly declined: string };

/** `--applied`'s value: a commit sha, whole or abbreviated, before it is checked against the pull request. */
export const checkedSha = (value: string): string => {
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new Failure(STAGE, "--applied takes a commit sha (7 to 40 hex digits)");
  return value.toLowerCase();
};

export const checkedOutcome = (outcome: Outcome): Outcome =>
  "applied" in outcome ? { applied: checkedSha(outcome.applied) } : { declined: checkedText(STAGE, "the reason --declined gives", outcome.declined) };

/** The reply's words, once `--applied`'s commit is known by its full sha. */
export const outcomeText = (outcome: Outcome): string => ("applied" in outcome ? `Applied in ${outcome.applied}.` : `Declined: ${outcome.declined}`);

/** The reply marker, when the answer is to a finding or notify with an id; a reply needs no answer either way. */
const marker = (to: string | undefined, session: string | undefined): string[] =>
  to === undefined ? [] : [replyMarker({ v: 1, to, ...(session === undefined ? {} : { session }) })];

/** A reply in a finding's review thread, or to a notify on its own thread. */
export const replyBody = (to: string | undefined, session: string | undefined, outcome: Outcome): string => [...marker(to, session), outcomeText(outcome)].join("\n");

/**
 * The line of a review's body that lists finding `id`, without its marker,
 * to quote in a reply; undefined when the body does not list it.
 */
export const listedFinding = (body: string, id: string): string | undefined => {
  const line = body.split("\n").find((item) => parseFinding(item)?.id === id);
  return line === undefined ? undefined : inert(line.replace(/ ?<!-- agent-finding \{[^\n]*?\} -->/, "").replace(/^- /, "").trim());
};

/**
 * A pull request comment answering a finding in a review's body, which has no
 * thread of its own: it links the review and quotes the finding it answers.
 */
export const bodyReplyBody = (input: { readonly to: string | undefined; readonly session: string | undefined; readonly reviewUrl: string; readonly quoted: string | undefined; readonly outcome: Outcome }): string =>
  [
    ...marker(input.to, input.session),
    `On ${input.to === undefined ? "the findings in" : "a finding in"} ${input.reviewUrl}${input.quoted === undefined ? ":" : `:\n\n> ${input.quoted.replace(/\n/g, "\n> ")}`}`,
    "",
    outcomeText(input.outcome),
  ].join("\n");
