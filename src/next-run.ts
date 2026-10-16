/**
 * `agent-gh next` and `claim --next`: reads the Queue, the ready issues,
 * their `blocked_by` graph, and their claims through an injected reader (as
 * soltui's next-issues.ts does), then orders them with next.ts.
 */
import { taken } from "./claim.ts";
import { claim, type ClaimIo, UNKNOWN } from "./claim-run.ts";
import { Failure, type Stage } from "./failure.ts";
import { request } from "./github.ts";
import { type Blocker, frontier, labelFilter, type LabelRules, NO_RULES, type Node, parseQueue, skippedText, type WaveIssue, type Waves, waves } from "./next.ts";
import { parseRepo, type Repo, slug } from "./repo.ts";
import { CONFIG_PATH } from "./review.ts";
import type { ApiIo } from "./threads-run.ts";

/**
 * Reads a REST endpoint (a path without the leading slash, as `gh api` takes
 * it): a list endpoint's every page, joined; undefined for a 404.
 */
export type Read = (endpoint: string) => Promise<unknown>;

const STAGE: Stage = "finding the next issue";
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * A list the order depends on: a 404 or anything but a list fails, rather
 * than read as empty, since an empty blocker, pull request, or comment list
 * would offer an issue that is blocked or claimed.
 */
const readList = async (read: Read, endpoint: string): Promise<unknown[]> => {
  const value = await read(endpoint);
  if (!Array.isArray(value)) throw new Failure(STAGE, `GET /${endpoint.split("?")[0]} gave no list (not found, or not readable with this token)`);
  return value;
};

/** The reader over GitHub's REST API with a token; it refuses a list too long to read whole. */
export const apiReader = (io: ApiIo, maxPages = 30): Read => async (endpoint) => {
  const items: unknown[] = [];
  const join = endpoint.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const path = `/${endpoint}${join}per_page=100&page=${page}`;
    const { status, value } = await request(io.api, STAGE, "GET", path, io.token);
    if (status === 404 || status === 410) return undefined;
    if (status === 401) throw new Failure(STAGE, "GitHub refused the token (HTTP 401)");
    if (status < 200 || status >= 300) throw new Failure(STAGE, `HTTP ${status} from GET /${endpoint.split("?")[0]}`);
    if (!Array.isArray(value)) return value;
    items.push(...value);
    if (value.length < 100) return items;
  }
  throw new Failure(STAGE, `/${endpoint.split("?")[0]} lists over ${maxPages * 100} items`);
};

export type QueueConfig = { readonly issue: number | undefined; readonly label: string; readonly priorityLabels: readonly string[]; readonly skipLabels: readonly string[] };

/** penmon's and soltui's priority labels, highest first. */
export const DEFAULT_PRIORITY_LABELS = ["priority:high", "priority:medium", "priority:low"];

/**
 * `queue` in the review config on the default branch: `{"issue": N, "label":
 * "ready", "priority_labels": [...], "skip_labels": [...]}`, all optional.
 */
export const queueConfig = async (repo: Repo, read: Read): Promise<QueueConfig> => {
  const base = text(record(await read(`repos/${slug(repo)}`)).default_branch);
  const file = await read(`repos/${slug(repo)}/contents/${CONFIG_PATH}?ref=${encodeURIComponent(base)}`);
  if (file === undefined) return { issue: undefined, label: "ready", priorityLabels: DEFAULT_PRIORITY_LABELS, skipLabels: [] };
  let config: unknown;
  try {
    config = JSON.parse(Buffer.from(text(record(file).content), "base64").toString("utf8"));
  } catch {
    throw new Failure(STAGE, `${CONFIG_PATH} on ${base} is not valid JSON`);
  }
  const queue = record(config).queue;
  if (queue === undefined) return { issue: undefined, label: "ready", priorityLabels: DEFAULT_PRIORITY_LABELS, skipLabels: [] };
  const value = record(queue);
  if (typeof queue !== "object" || queue === null || Array.isArray(queue) || Object.keys(value).some((key) => !["issue", "label", "priority_labels", "skip_labels"].includes(key))) {
    throw new Failure(STAGE, `${CONFIG_PATH}: queue takes issue, label, priority_labels, and skip_labels`);
  }
  if (value.issue !== undefined && !(Number.isSafeInteger(value.issue) && (value.issue as number) > 0)) throw new Failure(STAGE, `${CONFIG_PATH}: queue.issue must be an issue number`);
  if (value.label !== undefined && (typeof value.label !== "string" || value.label.trim() === "")) throw new Failure(STAGE, `${CONFIG_PATH}: queue.label must be a label name`);
  const priority = value.priority_labels;
  if (priority !== undefined && !(Array.isArray(priority) && priority.every((name) => typeof name === "string" && name.trim() !== ""))) {
    throw new Failure(STAGE, `${CONFIG_PATH}: queue.priority_labels must be a list of label names, highest first ([] for none)`);
  }
  const skip = value.skip_labels;
  if (skip !== undefined && !(Array.isArray(skip) && skip.every((pattern) => typeof pattern === "string" && pattern.trim() !== ""))) {
    throw new Failure(STAGE, `${CONFIG_PATH}: queue.skip_labels must be a list of label patterns`);
  }
  return {
    issue: value.issue as number | undefined,
    label: (value.label as string | undefined) ?? "ready",
    priorityLabels: (priority as string[] | undefined) ?? DEFAULT_PRIORITY_LABELS,
    skipLabels: (skip as string[] | undefined) ?? [],
  };
};

/** `owner/name` of an issue's `repository_url`. */
const repoOf = (issue: Record<string, unknown>): string | undefined => {
  const repo = parseRepo(text(issue.repository_url).replace(/^https:\/\/api\.github\.com\/repos\//, ""));
  return repo === undefined ? undefined : slug(repo);
};

export type NextResult = Waves & { readonly config: QueueConfig; readonly queued: boolean };

/**
 * The graph from GitHub: the Queue's issues and the ready ones, and every
 * open blocker of theirs in this repository, transitively; a blocker in
 * another repository is read from the dependency list and never followed.
 * The label filters (the flags' `rules` and the config's `skip_labels`) mark
 * a dispatched issue skipped; it stays in the graph.
 */
export const nextIssues = async (repo: Repo, read: Read, rules: LabelRules = NO_RULES): Promise<NextResult> => {
  const name = slug(repo);
  const config = await queueConfig(repo, read);
  const filters: LabelRules = { ...rules, configured: [...config.skipLabels, ...(rules.configured ?? [])] };
  const queueIssue = config.issue === undefined ? undefined : await read(`repos/${name}/issues/${config.issue}`);
  if (config.issue !== undefined && queueIssue === undefined) throw new Failure(STAGE, `the Queue issue #${config.issue} (\`queue.issue\` in ${CONFIG_PATH}) cannot be read`);
  const queue = queueIssue === undefined ? undefined : parseQueue(text(record(queueIssue).body));
  const ready = (await readList(read, `repos/${name}/issues?state=open&labels=${encodeURIComponent(config.label)}`)).map(record).filter((item) => item.pull_request === undefined);
  const known = new Map<number, Record<string, unknown>>(ready.map((item) => [item.number as number, item]));
  const readyNumbers = new Set(known.keys());
  const pulls = await readList(read, `repos/${name}/pulls?state=open`);
  const nodes = new Map<number, Node>();
  const todo = [...(queue ?? []), ...[...readyNumbers].sort((a, b) => a - b)];
  const seen = new Set<number>();
  while (todo.length > 0) {
    const number = todo.shift() as number;
    if (seen.has(number)) continue;
    seen.add(number);
    const issue = known.get(number) ?? record(await read(`repos/${name}/issues/${number}`));
    if (text(issue.state) !== "open" || issue.pull_request !== undefined) continue;
    const blockers = (await readList(read, `repos/${name}/issues/${number}/dependencies/blocked_by`)).map(record).map((item): Blocker => {
      const from = repoOf(item);
      const here = from === undefined || from.toLowerCase() === name.toLowerCase();
      if (here) known.set(item.number as number, item);
      return { repo: here ? undefined : from, number: item.number as number, open: text(item.state) === "open", title: text(item.title) };
    });
    for (const blocker of blockers) if (blocker.repo === undefined && blocker.open) todo.push(blocker.number);
    const dispatched = readyNumbers.has(number) && (queue === undefined || queue.includes(number));
    // Every open issue in the graph: a worker on a blocker that is not dispatched (no longer ready or queued) still shows.
    const holder = taken(repo, issue, pulls, await readList(read, `repos/${name}/issues/${number}/comments`)).holder;
    const names = list(issue.labels).map((item) => text(record(item).name));
    const rank = config.priorityLabels.findIndex((name) => names.includes(name));
    const skipped = dispatched ? labelFilter(names, filters) : undefined;
    nodes.set(number, {
      number, title: text(issue.title), dispatched, blockers, claim: holder, labels: names,
      ...(skipped === undefined ? {} : { skipped }),
      ...(rank === -1 ? {} : { priority: { label: config.priorityLabels[rank] as string, rank } }),
    });
  }
  return { ...waves({ queue, nodes }), config, queued: queue !== undefined };
};

const claimNote = (item: WaveIssue) =>
  item.claim === null ? "" : `in progress: ${item.claim.pr === null ? "a claim comment" : `#${item.claim.pr}`}${item.claim.family === null ? "" : ` by ${item.claim.family} ${item.claim.session}`}`;

/** The note when no Queue is configured: the order falls back to issue numbers. */
const fallback = (result: NextResult) =>
  `agent-gh: no Queue issue is configured (\`queue.issue\` in ${CONFIG_PATH}); falling back to open \`${result.config.label}\` issues by priority label, then the ones that unblock the most, then by number`;

/** One stderr line per issue of wave 1 the label filters left out. */
const skippedNotes = (result: NextResult, print: (line: string) => void) => {
  for (const item of result.waves[0] ?? []) if (item.state === "skipped" && item.skipped_by !== null) print(`agent-gh: skipped #${item.issue} ${item.title}: ${skippedText(item.skipped_by)}`);
};

/** Plain `next`: one workable issue per line, the next first; claimed and skipped ones go to `print`. */
export const nextLines = (result: NextResult, print: (line: string) => void): string[] => {
  if (!result.queued) print(fallback(result));
  skippedNotes(result, print);
  const items = frontier(result);
  for (const item of items.filter((candidate) => candidate.state === "in_progress")) print(`agent-gh: #${item.issue} ${item.title}: ${claimNote(item)}`);
  const workable = items.filter((item) => item.state === "workable");
  return workable.length === 0
    ? [`No eligible issue: none ${result.queued ? "in the Queue " : ""}is open, \`${result.config.label}\`, unblocked, and unclaimed.`]
    : workable.map((item) => `#${item.issue} ${item.title}`);
};

/** `next --json`: the frontier with each issue's labels and claim. */
export const nextJson = (repo: Repo, result: NextResult) => ({
  v: 1,
  repo: slug(repo),
  queue: result.config.issue ?? null,
  label: result.config.label,
  issues: frontier(result).map((item) => ({ issue: item.issue, title: item.title, priority: item.priority, labels: item.labels, claim: item.claim })),
});

/** `next --waves --json`. */
export const wavesJson = (repo: Repo, result: NextResult) => ({
  v: 1,
  repo: slug(repo),
  queue: result.config.issue ?? null,
  label: result.config.label,
  waves: result.waves.map((issues, index) => ({ wave: index + 1, issues })),
  stuck: result.stuck,
  cycles: result.cycles,
});

/** `next --waves` for a person. */
export const wavesLines = (result: NextResult, print: (line: string) => void): string[] => {
  if (!result.queued) print(fallback(result));
  const line = (item: WaveIssue) => {
    const notes = [
      item.queued === null ? "" : `queue ${item.queued + 1}`,
      item.priority ?? "",
      item.unblocks === 0 ? "" : `unblocks ${item.unblocks}`,
      item.waiting_on.length === 0 ? "" : `waits on ${item.waiting_on.join(", ")}`,
      item.state === "not_dispatched" ? `not dispatched` : "",
      item.skipped_by === null ? "" : `skipped: ${skippedText(item.skipped_by)}`,
      claimNote(item),
    ].filter((note) => note !== "");
    return `  #${item.issue} ${item.title}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`;
  };
  const lines: string[] = [];
  result.waves.forEach((issues, index) => {
    if (index === 0) {
      lines.push("Wave 1, workable now:", ...issues.filter((item) => item.state === "workable").map(line));
      const busy = issues.filter((item) => item.state === "in_progress");
      if (busy.length > 0) lines.push("Wave 1, in progress:", ...busy.map(line));
      const idle = issues.filter((item) => item.state === "not_dispatched");
      if (idle.length > 0) lines.push("Wave 1, unblocked but not dispatched:", ...idle.map(line));
      const left = issues.filter((item) => item.state === "skipped");
      if (left.length > 0) lines.push("Wave 1, skipped by a label filter:", ...left.map(line));
    } else lines.push(`Wave ${index + 1}:`, ...issues.map(line));
  });
  if (result.stuck.length > 0) lines.push("Stuck (a cycle, or an open issue elsewhere):", ...result.stuck.map(line));
  for (const cycle of result.cycles) lines.push(`Cycle: ${cycle.map((number) => `#${number}`).join(", ")} block one another`);
  return lines.length === 0 ? ["No issue in the graph."] : lines;
};

/** Attempts `claim --next` makes before giving up on a frontier others keep taking. */
const ATTEMPTS = 3;

/**
 * `agent-gh claim --next`: claims the first workable issue; when that claim
 * loses a race (or the issue was taken meanwhile), reads the frontier again
 * and tries the next, a few times at most. The label filters apply to each read.
 */
export const claimNext = async (io: ClaimIo, read: Read, options: { readonly refs: boolean; readonly noPr: boolean; readonly rules?: LabelRules }): Promise<number> => {
  const tried = new Set<number>();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await nextIssues(io.repo, read, options.rules);
    if (attempt === 1 && !result.queued) io.print(fallback(result));
    if (attempt === 1) skippedNotes(result, io.print);
    const pick = frontier(result).find((item) => item.state === "workable" && !tried.has(item.issue));
    if (pick === undefined) {
      io.print(`agent-gh: no eligible issue: none ${result.queued ? "in the Queue " : ""}is open, \`${result.config.label}\`, unblocked, and unclaimed`);
      return 1;
    }
    io.print(`agent-gh: claiming #${pick.issue} ${pick.title}`);
    const code = await claim(io, { issue: pick.issue, refs: options.refs, noPr: options.noPr });
    // Only a refusal or a lost race leaves no claim behind; an unconfirmed one stands, so nothing more is claimed.
    if (code === 0 || code === UNKNOWN) return code;
    tried.add(pick.issue);
  }
  io.print(`agent-gh: gave up after ${ATTEMPTS} claims went to others; run \`agent-gh next --waves\` to see the frontier`);
  return 1;
};
