import { postingApps, type Registry } from "./config.ts";
import { Failure, type Stage } from "./failure.ts";
import { type Api, request } from "./github.ts";
import { parseRepo, type Repo, slug } from "./repo.ts";
import { awaitingOwner, type RequiredComment, requiredComments, type ThreadComment, type ThreadsInput } from "./threads.ts";

/** What reading a repository's threads needs: the API, a token, and the repository. */
export type ApiIo = {
  readonly api: Api;
  readonly token: string;
  readonly repo: Repo;
  /** The App registry; tests pass their own, everything else reads apps.json. */
  readonly registry?: Registry;
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export const get = async (io: ApiIo, stage: Stage, path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> => {
  const { status, value } = await request(io.api, stage, method, path, io.token, body);
  if (status === 401) throw new Failure(stage, "GitHub refused the token (HTTP 401)");
  if (status < 200 || status >= 300) throw new Failure(stage, `HTTP ${status} from ${method} ${path.split("?")[0]}`);
  return value;
};

/** Every item of a list endpoint, refusing one too long to read whole, so nothing past the end is missed. */
export const everyPage = async (io: ApiIo, stage: Stage, path: string, maxPages = 30): Promise<unknown[]> => {
  const items: unknown[] = [];
  const join = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const value = await get(io, stage, `${path}${join}per_page=100&page=${page}`);
    if (!Array.isArray(value)) throw new Failure(stage, `${path.split("?")[0]}: invalid response`);
    items.push(...value);
    if (value.length < 100) return items;
  }
  throw new Failure(stage, `${path.split("?")[0]} lists over ${maxPages * 100} items`);
};

/** The repository owner's login, as GitHub spells it. */
export const repoOwner = async (io: ApiIo, stage: Stage): Promise<string> => {
  const owner = text(record(record(await get(io, stage, `/repos/${slug(io.repo)}`)).owner).login);
  if (owner === "") throw new Failure(stage, `${slug(io.repo)}: invalid response`);
  return owner;
};

/** The most issues one pull request may close and still be read whole. */
const CLOSING_LISTED = 25;

/**
 * The issues a pull request closes, in whichever repositories. More than
 * GitHub lists in one page is refused: a label on one left out would hold
 * nothing, and a comment on it would wait for no answer.
 */
export const closingIssues = async (io: ApiIo, stage: Stage, number: number): Promise<{ readonly repo: Repo; readonly number: number }[]> => {
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:${CLOSING_LISTED}){totalCount nodes{number repository{nameWithOwner}}}}}}`;
  const value = await get(io, stage, "/graphql", "POST", { query, variables: { owner: io.repo.owner, name: io.repo.name, number } });
  const references = record(record(record(record(value).data).repository).pullRequest).closingIssuesReferences;
  const nodes = record(references).nodes;
  if (!Array.isArray(nodes)) throw new Failure(stage, `the issues #${number} closes: invalid response`);
  const total = record(references).totalCount;
  if (Number.isSafeInteger(total) && (total as number) > nodes.length) throw new Failure(stage, `#${number} closes over ${CLOSING_LISTED} issues, too many to read`);
  return nodes.flatMap((node) => {
    const repo = parseRepo(text(record(record(node).repository).nameWithOwner));
    const issue = record(node).number;
    return repo !== undefined && Number.isSafeInteger(issue) ? [{ repo, number: issue as number }] : [];
  });
};

const comment = (value: unknown, thread: string): ThreadComment => {
  const item = record(value);
  const app = record(item.performed_via_github_app).id;
  const thumbsUp = record(item.reactions)["+1"];
  return {
    id: Number.isSafeInteger(item.id) ? (item.id as number) : 0,
    thread,
    url: text(item.html_url),
    author: text(record(item.user).login),
    appId: Number.isSafeInteger(app) ? (app as number) : undefined,
    createdAt: text(item.created_at),
    updatedAt: text(item.updated_at),
    body: text(item.body),
    thumbsUp: Number.isSafeInteger(thumbsUp) ? (thumbsUp as number) : 0,
  };
};

/** Every conversation comment on issue or pull request `number` in `repo`, as `thread`'s. */
export const issueComments = async (io: ApiIo, stage: Stage, repo: Repo, number: number, thread: string): Promise<ThreadComment[]> =>
  (await everyPage(io, stage, `/repos/${slug(repo)}/issues/${number}/comments`)).map((item) => comment(item, thread));

/**
 * The comments that keep agent-threads failing on pull request `number`: read
 * from its conversation and every issue it closes, with the owner's 👍
 * reactions read only on the comments that would otherwise count.
 */
export const pullThreads = async (
  io: ApiIo,
  stage: Stage,
  pull: { readonly number: number; readonly createdAt: string },
  owner: string,
): Promise<RequiredComment[]> => {
  const where = new Map<number, Repo>();
  const comments = (await issueComments(io, stage, io.repo, pull.number, `#${pull.number}`)).map((item) => (where.set(item.id, io.repo), item));
  for (const issue of await closingIssues(io, stage, pull.number)) {
    const thread = slug(issue.repo).toLowerCase() === slug(io.repo).toLowerCase() ? `#${issue.number}` : `${slug(issue.repo)}#${issue.number}`;
    for (const item of await issueComments(io, stage, issue.repo, issue.number, thread)) {
      where.set(item.id, issue.repo);
      comments.push(item);
    }
  }
  const input: ThreadsInput = { owner, agentApps: postingApps(io.registry).map((app) => app.id), since: pull.createdAt, comments };
  const thumbedUp = new Set<number>();
  for (const candidate of awaitingOwner(input)) {
    if (candidate.thumbsUp === 0) continue;
    const repo = where.get(candidate.id) ?? io.repo;
    const reactions = await everyPage(io, stage, `/repos/${slug(repo)}/issues/comments/${candidate.id}/reactions?content=%2B1`, 10);
    if (reactions.some((reaction) => text(record(record(reaction).user).login).toLowerCase() === owner.toLowerCase())) thumbedUp.add(candidate.id);
  }
  return requiredComments(input, thumbedUp);
};

/** The refusal text naming each comment that waits for an answer. */
export const describeRequired = (required: readonly RequiredComment[]): string =>
  required.map((item) => `${item.why} on ${item.thread} (${item.url})`).join(", ");
