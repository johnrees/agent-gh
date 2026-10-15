/**
 * `agent-gh notify` and `agent-gh reply` against GitHub. A notify posts an
 * agent's finding on another thread; a reply answers a review finding or a
 * notify, and resolves a finding's review thread once it is settled. Replies
 * never need an answer, so neither command can start a loop between agents.
 */
import { Failure, type Stage } from "./failure.ts";
import { request } from "./github.ts";
import { checkedSeverity, checkedText, notifyBody, notifyId, parseThreadRef, sameThread, type ThreadRef, threadName } from "./notify.ts";
import { parseRepo, type Repo, slug } from "./repo.ts";
import { ADDRESS_FORMS, type Address, bodyReplyBody, checkedOutcome, listedFinding, type Outcome, parseAddress, replyBody } from "./reply.ts";
import { parseFinding } from "./review.ts";
import { pull, pullNumber, type ReviewIo } from "./review-run.ts";
import { type ApiIo, closingIssues, everyPage, get } from "./threads-run.ts";
import { parseNotify } from "./threads.ts";

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const nodes = (value: unknown): Record<string, unknown>[] => {
  const list = record(value).nodes;
  return Array.isArray(list) ? list.map(record) : [];
};

/**
 * A GraphQL request. Review threads exist only in GraphQL, so a refusal says
 * that GraphQL is what failed: some proxies (Claude cloud's) reject it.
 * GitHub's error messages are response text, so only their type codes are shown.
 */
export const graphql = async (io: ApiIo, stage: Stage, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const { status, value } = await request(io.api, stage, "POST", "/graphql", io.token, { query, variables });
  if (status === 401) throw new Failure(stage, "GitHub refused the stored login (HTTP 401)");
  if (status < 200 || status >= 300) {
    throw new Failure(stage, `GitHub's GraphQL API answered HTTP ${status}; review threads are answered and resolved only through GraphQL, which some proxies (Claude cloud's) reject, so run this from a local session`);
  }
  const errors = record(value).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const types = [...new Set(errors.map((error) => text(record(error).type)).filter((type) => /^[A-Z_]{1,40}$/.test(type)))];
    throw new Failure(stage, `GitHub's GraphQL API refused the request${types.length === 0 ? "" : ` (${types.join(", ")})`}`);
  }
  return record(record(value).data);
};

const STAGE = "replying";
const at = (io: ApiIo, repo: Repo): ApiIo => ({ ...io, repo });

/** A review thread: its node id, whether it is resolved, and its comments, the finding first. */
type Thread = { readonly id: string; readonly resolved: boolean; readonly pr: ThreadRef; readonly comments: readonly { readonly id: number; readonly body: string }[] };

const THREAD_FIELDS = "id isResolved comments(first:100){nodes{databaseId body}}";

const thread = (node: Record<string, unknown>, pr: ThreadRef): Thread => ({
  id: text(node.id),
  resolved: node.isResolved === true,
  pr,
  comments: nodes(node.comments).map((comment) => ({ id: Number.isSafeInteger(comment.databaseId) ? (comment.databaseId as number) : 0, body: text(comment.body) })),
});

/** Every review thread on pull request `pr`. */
const reviewThreads = async (io: ApiIo, pr: ThreadRef): Promise<Thread[]> => {
  const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{${THREAD_FIELDS}}}}}}`;
  const threads: Thread[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data = await graphql(io, STAGE, query, { owner: pr.repo.owner, name: pr.repo.name, number: pr.number, after });
    const list = record(record(record(data.repository).pullRequest).reviewThreads);
    if (!Array.isArray(list.nodes)) throw new Failure(STAGE, `${threadName(pr)} is not a pull request GitHub shows`);
    threads.push(...nodes(list).map((node) => thread(node, pr)));
    const info = record(list.pageInfo);
    if (info.hasNextPage !== true) return threads;
    after = text(info.endCursor);
  }
  throw new Failure(STAGE, `${threadName(pr)} has over 2,000 review threads`);
};

/** What a reply answers, once found: a review thread, a finding in a review's body, or a conversation comment. */
type Target =
  | { readonly kind: "thread"; readonly thread: Thread; readonly to: string | undefined }
  | { readonly kind: "body"; readonly pr: ThreadRef; readonly reviewUrl: string; readonly quoted: string | undefined; readonly to: string | undefined }
  /** A comment on `on`'s conversation; `pr` is the pull request a fix would be on, when one is known. */
  | { readonly kind: "conversation"; readonly on: ThreadRef; readonly pr: ThreadRef | undefined; readonly to: string | undefined };

const issueComments = async (io: ApiIo, ref: ThreadRef, stage: Stage = STAGE) => (await everyPage(at(io, ref.repo), stage, `/repos/${slug(ref.repo)}/issues/${ref.number}/comments`)).map(record);

/** A finding or notify id on pull request `pr`: in a review thread, a review's body, or a comment on it or an issue it closes. */
const findId = async (io: ApiIo, pr: ThreadRef, id: string): Promise<Target> => {
  const found = (await reviewThreads(io, pr)).find((item) => parseFinding(item.comments[0]?.body ?? "")?.id === id);
  if (found !== undefined) return { kind: "thread", thread: found, to: id };
  const reviews = (await everyPage(at(io, pr.repo), STAGE, `/repos/${slug(pr.repo)}/pulls/${pr.number}/reviews`)).map(record);
  const review = reviews.find((item) => listedFinding(text(item.body), id) !== undefined);
  if (review !== undefined) return { kind: "body", pr, reviewUrl: text(review.html_url), quoted: listedFinding(text(review.body), id), to: id };
  const threads = [pr, ...(await closingIssues(at(io, pr.repo), STAGE, pr.number))];
  for (const on of threads) {
    if ((await issueComments(io, on)).some((comment) => parseNotify(text(comment.body))?.id === id)) return { kind: "conversation", on, pr, to: id };
  }
  throw new Failure(STAGE, `no finding or notify ${id} on ${threadName(pr)} or an issue it closes; pass --pr N for another pull request, or the comment's URL`);
};

/** The pull request a reply is about: `--pr`, else the current branch's. */
const contextPull = async (io: ReviewIo, pr: number | undefined): Promise<ThreadRef | undefined> => {
  const number = pr ?? (await pullNumber(io, STAGE, { branch: undefined }));
  return number === undefined ? undefined : { repo: io.repo, number };
};

const find = async (io: ReviewIo, address: Address, pr: number | undefined): Promise<Target> => {
  switch (address.kind) {
    case "id": {
      const context = await contextPull(io, pr);
      if (context === undefined) throw new Failure(STAGE, "no open pull request for this branch; pass --pr N, or the finding's URL");
      return findId(io, context, address.id);
    }
    case "comment": {
      const ref = { repo: address.repo, number: address.number };
      const found = (await reviewThreads(io, ref)).find((item) => item.comments.some((comment) => comment.id === address.commentId));
      if (found === undefined) throw new Failure(STAGE, `no review thread on ${threadName(ref)} holds comment ${address.commentId}`);
      return { kind: "thread", thread: found, to: parseFinding(found.comments[0]?.body ?? "")?.id };
    }
    case "thread": {
      const query = `query($id:ID!){node(id:$id){... on PullRequestReviewThread{${THREAD_FIELDS} pullRequest{number repository{nameWithOwner}}}}}`;
      const node = record((await graphql(io, STAGE, query, { id: address.node })).node);
      const repo = parseRepo(text(record(record(node.pullRequest).repository).nameWithOwner));
      const number = record(node.pullRequest).number;
      if (repo === undefined || !Number.isSafeInteger(number)) throw new Failure(STAGE, `${address.node} is not a review thread GitHub shows`);
      const found = thread(node, { repo, number: number as number });
      return { kind: "thread", thread: found, to: parseFinding(found.comments[0]?.body ?? "")?.id };
    }
    case "review": {
      const ref = { repo: address.repo, number: address.number };
      const review = record(await get(at(io, ref.repo), STAGE, `/repos/${slug(ref.repo)}/pulls/${ref.number}/reviews/${address.reviewId}`));
      return { kind: "body", pr: ref, reviewUrl: text(review.html_url), quoted: undefined, to: undefined };
    }
    case "issueComment": {
      const on = { repo: address.repo, number: address.number };
      const comment = record(await get(at(io, on.repo), STAGE, `/repos/${slug(on.repo)}/issues/comments/${address.commentId}`));
      const issue = record(await get(at(io, on.repo), STAGE, `/repos/${slug(on.repo)}/issues/${on.number}`));
      // A comment on an issue: the fix is on the pull request this branch, or --pr, names.
      const context = issue.pull_request !== undefined ? on : await contextPull(io, pr);
      return { kind: "conversation", on, pr: context, to: parseNotify(text(comment.body))?.id };
    }
  }
};

/**
 * `--applied`'s commit as its full sha, once it is one of pull request `pr`'s
 * commits (on its head branch since the base). Without a pull request, the
 * commit need only exist in `repo`.
 */
const appliedCommit = async (io: ApiIo, sha: string, pr: ThreadRef | undefined, repo: Repo): Promise<string> => {
  if (pr === undefined) {
    const { status, value } = await request(io.api, STAGE, "GET", `/repos/${slug(repo)}/commits/${sha}`, io.token);
    const full = text(record(value).sha);
    if (status !== 200 || full === "") throw new Failure(STAGE, `${sha} is not a commit in ${slug(repo)}; push it first`);
    return full;
  }
  const commits = (await everyPage(at(io, pr.repo), STAGE, `/repos/${slug(pr.repo)}/pulls/${pr.number}/commits`, 3)).map((commit) => text(record(commit).sha));
  const matches = commits.filter((full) => full.startsWith(sha));
  if (matches.length > 1) throw new Failure(STAGE, `${sha} names more than one of ${threadName(pr)}'s commits; give more of the sha`);
  if (matches.length === 1) return matches[0] as string;
  // GitHub lists at most 250 of a pull request's commits; past that, ask whether the head contains it.
  if (commits.length >= 250) {
    const head = (await pull(at(io, pr.repo), STAGE, pr.number)).head;
    const { status, value } = await request(io.api, STAGE, "GET", `/repos/${slug(pr.repo)}/compare/${sha}...${head}`, io.token);
    const full = text(record(record(value).base_commit).sha);
    if (status === 200 && ["ahead", "identical"].includes(text(record(value).status)) && full !== "") return full;
  }
  throw new Failure(STAGE, `${sha} is not on ${threadName(pr)}'s head branch; push the fix to it first, or answer with --declined "<why>"`);
};

export type ReplyOptions = { readonly address: string; readonly outcome: Outcome; readonly pr?: number };

/**
 * `agent-gh reply`: answers a finding or notify, as applied in a commit on
 * the pull request's head branch or declined for a reason. A finding with a
 * review thread is answered there and the thread resolved; one only in a
 * review's body, and a notify, are answered with a comment. Prints the reply's URL.
 */
export const replyCommand = async (io: ReviewIo, session: string | undefined, options: ReplyOptions): Promise<void> => {
  const address = parseAddress(options.address);
  if (address === undefined) throw new Failure(STAGE, `${JSON.stringify(options.address.slice(0, 80))} is not ${ADDRESS_FORMS}`);
  const checked = checkedOutcome(options.outcome);
  const target = await find(io, address, options.pr);
  const where = target.kind === "thread" ? target.thread.pr : target.kind === "body" ? target.pr : target.on;
  const pr = target.kind === "thread" ? target.thread.pr : target.pr;
  const outcome: Outcome = "applied" in checked ? { applied: await appliedCommit(io, checked.applied, pr, where.repo) } : checked;
  if (target.kind === "thread") {
    const reply = `mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{url}}}`;
    const data = await graphql(io, STAGE, reply, { thread: target.thread.id, body: replyBody(target.to, session, outcome) });
    const url = text(record(record(data.addPullRequestReviewThreadReply).comment).url);
    await graphql(io, STAGE, `mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}`, { thread: target.thread.id });
    io.print(`agent-gh: answered ${target.to ?? "the finding"} in its review thread on ${threadName(where)} and resolved the thread; John can unresolve it to reopen`);
    io.out(`${url}\n`);
    return;
  }
  const body =
    target.kind === "body"
      ? bodyReplyBody({ to: target.to, session, reviewUrl: target.reviewUrl, quoted: target.quoted, outcome })
      : replyBody(target.to, session, outcome);
  const posted = record(await get(at(io, where.repo), STAGE, `/repos/${slug(where.repo)}/issues/${where.number}/comments`, "POST", { body }));
  io.print(`agent-gh: answered ${target.to ?? "the comment"} with a comment on ${threadName(where)}${target.kind === "body" ? " (a finding in a review's body has no thread to resolve)" : ""}`);
  io.out(`${text(posted.html_url)}\n`);
};

export type NotifyOptions = { readonly target: string; readonly severity: string | undefined; readonly text: string; readonly from?: string };

/**
 * `agent-gh notify`: posts an agent's finding on another issue or pull
 * request, at P0 to P2, linked back to the thread it came from (`--from`, else
 * the current branch's pull request), with the session that sent it. The same
 * finding to the same thread is refused. Prints the comment's URL.
 */
export const notifyCommand = async (io: ReviewIo, session: string | undefined, options: NotifyOptions): Promise<void> => {
  const stage = "notifying";
  const target = parseThreadRef(options.target, io.repo);
  if (target === undefined) throw new Failure(stage, "name the thread to notify as N, owner/repo#N, or its URL");
  const severity = checkedSeverity(options.severity);
  const words = checkedText(stage, "the notify's text", options.text);
  let from: ThreadRef | undefined;
  if (options.from === undefined) {
    const number = await pullNumber(io, stage, { branch: undefined });
    from = number === undefined ? undefined : { repo: io.repo, number };
  } else {
    from = parseThreadRef(options.from, io.repo);
    if (from === undefined) throw new Failure(stage, "--from names a thread as N, owner/repo#N, or its URL");
    const { status } = await request(io.api, stage, "GET", `/repos/${slug(from.repo)}/issues/${from.number}`, io.token);
    if (status !== 200) throw new Failure(stage, `--from names ${threadName(from)}, which GitHub does not show (HTTP ${status})`);
  }
  if (from === undefined) throw new Failure(stage, "a notify links back to where it came from, and this branch has no open pull request; push it and open a draft, or pass --from <issue or pull request>");
  if (sameThread(from, target)) throw new Failure(stage, `a notify goes to another thread than ${threadName(from)}; answer there with a comment`);
  const id = notifyId(target, words);
  const duplicate = (await issueComments(io, target, stage)).find((comment) => parseNotify(text(comment.body))?.id === id);
  if (duplicate !== undefined) throw new Failure(stage, `${threadName(target)} already has this notify (${text(duplicate.html_url)}); a notify is sent once`);
  const body = notifyBody({ id, severity, session, from, text: words });
  const posted = record(await get(at(io, target.repo), stage, `/repos/${slug(target.repo)}/issues/${target.number}/comments`, "POST", { body }));
  io.print(`agent-gh: notify ${id} (${severity}) is on ${threadName(target)}; it waits for \`agent-gh reply ${id}\``);
  io.out(`${text(posted.html_url)}\n`);
};
