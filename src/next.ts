/**
 * `agent-gh next`: which issues an agent may take, and in what order. Ported
 * from soltui's scripts/next-issues.ts (soltui#736) and extended with claims
 * and the `blocked_by` graph. Pure: next-run.ts reads GitHub.
 *
 * An issue is dispatched when it is open and carries the ready label and,
 * where a Queue issue is configured, its Queue lists it. It is workable when
 * it is dispatched, every blocker is closed, and nothing claims it. Waves
 * layer the open issues of the graph (the dispatched ones and their blockers,
 * transitively): wave 1 has no open blocker, and each later wave waits only
 * on earlier ones. This is a frontier for parallel workers to read, not a
 * scheduler. A dispatched issue the label filters leave out is skipped: never
 * offered or claimed, but still in the graph, so it blocks its dependents.
 */
import type { Claim } from "./claim.ts";
import { Failure } from "./failure.ts";
import { labelMatches, sameLabel } from "./review.ts";

/** The label filters of one call: patterns as `labelMatches` reads them, `*` matching any run of characters. */
export type LabelRules = {
  /** `--skip-label`: leave out an issue when any of its labels matches. */
  readonly skip: readonly string[];
  /** `--require-label`: leave out an issue unless some label matches each pattern. */
  readonly require: readonly string[];
  /** `--fit-label`: leave out an issue with a label in the pattern's group unless that label also matches it. */
  readonly fit: readonly string[];
  /** `queue.skip_labels`, applied like `skip` and named for it in the reason. */
  readonly configured?: readonly string[];
  /** `hold.label`, where the config has `hold`: an issue carrying it, in any case (GitHub's labels ignore it), waits for John. */
  readonly held?: string;
};

export const NO_RULES: LabelRules = { skip: [], require: [], fit: [] };

/** Why an issue is filtered: the rule that matched, its pattern, and the label that matched (null when a required one is missing). */
export type SkippedBy = { readonly rule: string; readonly pattern: string; readonly label: string | null };

/** The group a `--fit-label` pattern names: its text up to and including the first `:`; undefined without one. */
export const fitGroup = (pattern: string): string | undefined => {
  const colon = pattern.indexOf(":");
  return colon === -1 ? undefined : pattern.slice(0, colon + 1);
};

/** The rule as a person reads it: `queue.skip_labels`, or the flag with its pattern. */
export const ruleText = (by: SkippedBy): string => (by.rule.startsWith("--") ? `${by.rule} ${by.pattern}` : by.rule);

/** The reason as a sentence: `carries needs-human (queue.skip_labels)`. */
export const skippedText = (by: SkippedBy): string => `${by.label === null ? `lacks a label matching ${by.pattern}` : `carries ${by.label}`} (${ruleText(by)})`;

/**
 * Why a picker leaves out an issue with these labels, or undefined to keep
 * it. Checked in order: `hold.label`, `queue.skip_labels`, `--skip-label`,
 * `--require-label`, `--fit-label`. Throws on a fit pattern with no `:`.
 */
export const labelFilter = (labels: readonly string[], rules: LabelRules): SkippedBy | undefined => {
  const waiting = rules.held === undefined ? undefined : labels.find((label) => sameLabel(label, rules.held as string));
  if (waiting !== undefined) return { rule: "hold.label", pattern: rules.held as string, label: waiting };
  const skips = [...(rules.configured ?? []).map((pattern) => ({ rule: "queue.skip_labels", pattern })), ...rules.skip.map((pattern) => ({ rule: "--skip-label", pattern }))];
  for (const { rule, pattern } of skips) {
    const label = labels.find((candidate) => labelMatches(pattern, candidate));
    if (label !== undefined) return { rule, pattern, label };
  }
  const missing = rules.require.find((pattern) => !labels.some((label) => labelMatches(pattern, label)));
  if (missing !== undefined) return { rule: "--require-label", pattern: missing, label: null };
  for (const pattern of rules.fit) {
    const group = fitGroup(pattern);
    if (group === undefined) throw new Failure("finding the next issue", `--fit-label ${pattern}: a fit pattern names a label group, so it needs a ":" (model:sonnet-*)`);
    const label = labels.find((candidate) => labelMatches(`${group}*`, candidate) && !labelMatches(pattern, candidate));
    if (label !== undefined) return { rule: "--fit-label", pattern, label };
  }
  return undefined;
};

/**
 * The issues a Queue issue's body orders: each numbered list item queues the
 * first issue it references; every other mention (a blocker named in an
 * entry, a bullet) is context. Duplicates keep their first place.
 */
export const parseQueue = (body: string): number[] => [
  ...new Set([...body.matchAll(/^\d+\.[ \t][^\n]*?(?<![\w/.-])#(\d+)(?!\w)/gm)].map((match) => Number(match[1]))),
];

/** An issue that blocks another: in this repository (`repo` undefined) or another. */
export type Blocker = { readonly repo: string | undefined; readonly number: number; readonly open: boolean; readonly title: string };

/** An open issue of this repository in the graph. */
export type Node = {
  readonly number: number;
  readonly title: string;
  /** Open, ready, and queued where a queue is configured. */
  readonly dispatched: boolean;
  readonly blockers: readonly Blocker[];
  /** The claim holding it, if any. */
  readonly claim: Claim | undefined;
  /** Its label names. */
  readonly labels: readonly string[];
  /** Why the label filters leave it out, if they do. It still blocks its dependents. */
  readonly skipped?: SkippedBy;
  /** Its highest priority label, and that label's rank (0 highest); undefined for none. */
  readonly priority?: { readonly label: string; readonly rank: number };
};

export type GraphInput = {
  /** The Queue's order, or undefined when no queue is configured. */
  readonly queue: readonly number[] | undefined;
  /** Every open issue of this repository in the graph, by number. Closed ones are left out: they block nothing. */
  readonly nodes: ReadonlyMap<number, Node>;
};

export type IssueState = "workable" | "in_progress" | "not_dispatched" | "skipped" | "waiting";

export type WaveIssue = {
  readonly issue: number;
  readonly title: string;
  readonly state: IssueState;
  /** Its place in the Queue (0 first), or null. */
  readonly queued: number | null;
  /** The open issues it waits on: `#N` here, `owner/repo#N` elsewhere. */
  readonly waiting_on: readonly string[];
  /** How many issues of the graph wait on it, directly or not. */
  readonly unblocks: number;
  /** Its highest priority label, or null. */
  readonly priority: string | null;
  /** Its label names, sorted. */
  readonly labels: readonly string[];
  /** The rule and label that filtered it (state `skipped`), or null. */
  readonly skipped_by: SkippedBy | null;
  readonly claim: { readonly kind: "pr" | "comment"; readonly pr: number | null; readonly url: string; readonly family: string | null; readonly session: string | null } | null;
};

export type Waves = {
  readonly waves: readonly (readonly WaveIssue[])[];
  /** Issues that cannot become workable here: on or behind a cycle, or behind an open issue in another repository. */
  readonly stuck: readonly WaveIssue[];
  readonly cycles: readonly (readonly number[])[];
};

const ref = (blocker: Blocker) => (blocker.repo === undefined ? `#${blocker.number}` : `${blocker.repo}#${blocker.number}`);

/** The strongly connected components of size above one, or with a self-loop: the cycles, each sorted. */
const cyclesOf = (nodes: ReadonlyMap<number, Node>, edges: (number: number) => number[]): number[][] => {
  // Tarjan's algorithm, iterative.
  let counter = 0;
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const found: number[][] = [];
  for (const start of [...nodes.keys()].sort((a, b) => a - b)) {
    if (index.has(start)) continue;
    const work: { node: number; next: number }[] = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: number; next: number };
      const out = edges(frame.node);
      if (frame.next < out.length) {
        const to = out[frame.next++] as number;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter++);
          stack.push(to);
          onStack.add(to);
          work.push({ node: to, next: 0 });
        } else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(to) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: number[] = [];
        let member: number;
        do {
          member = stack.pop() as number;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        if (component.length > 1 || out.includes(frame.node)) found.push(component.sort((a, b) => a - b));
      }
    }
  }
  return found.sort((a, b) => (a[0] as number) - (b[0] as number));
};

/**
 * Layers the graph into waves and orders each: the Queue's order first,
 * then the highest priority label, then the issues that unblock the most,
 * then by number. An issue on a
 * cycle, or waiting (directly or not) on one or on an open issue in another
 * repository, is stuck and never offered.
 */
export const waves = (input: GraphInput): Waves => {
  const { nodes } = input;
  const local = (number: number) => (nodes.get(number)?.blockers ?? []).filter((blocker) => blocker.open && blocker.repo === undefined && nodes.has(blocker.number)).map((blocker) => blocker.number);
  const cycles = cyclesOf(nodes, local);
  // Dependents, for counting what each issue unblocks.
  const dependents = new Map<number, number[]>();
  for (const number of nodes.keys()) for (const blocker of local(number)) dependents.set(blocker, [...(dependents.get(blocker) ?? []), number]);
  const unblocks = (number: number): number => {
    const seen = new Set<number>();
    const todo = [...(dependents.get(number) ?? [])];
    while (todo.length > 0) {
      const next = todo.pop() as number;
      if (next === number || seen.has(next)) continue;
      seen.add(next);
      todo.push(...(dependents.get(next) ?? []));
    }
    return seen.size;
  };
  // Wave: 1 with no open blocker, else one past its latest blocker; undefined when stuck.
  const wave = new Map<number, number | undefined>();
  const waveOf = (number: number, path: Set<number> = new Set()): number | undefined => {
    if (wave.has(number)) return wave.get(number);
    // Back on its own path: a cycle.
    if (path.has(number)) return undefined;
    const node = nodes.get(number) as Node;
    const open = node.blockers.filter((blocker) => blocker.open);
    let result: number | undefined = 1;
    if (open.some((blocker) => blocker.repo !== undefined || !nodes.has(blocker.number))) result = undefined;
    for (const blocker of local(number)) {
      if (result === undefined) break;
      const before = waveOf(blocker, new Set([...path, number]));
      result = before === undefined ? undefined : Math.max(result, before + 1);
    }
    wave.set(number, result);
    return result;
  };
  const queued = (number: number) => {
    const at = input.queue?.indexOf(number) ?? -1;
    return at === -1 ? null : at;
  };
  const entry = (number: number, layer: number | undefined): WaveIssue => {
    const node = nodes.get(number) as Node;
    const waitingOn = node.blockers.filter((blocker) => blocker.open).map(ref);
    // A filtered issue is skipped in whatever wave it lands; waiting_on still says what it waits on.
    const state: IssueState =
      node.skipped !== undefined ? "skipped" : layer !== 1 ? "waiting" : !node.dispatched ? "not_dispatched" : node.claim !== undefined ? "in_progress" : "workable";
    const claim = node.claim === undefined ? null : { kind: node.claim.kind, pr: node.claim.pr, url: node.claim.url, family: node.claim.family, session: node.claim.session };
    return { issue: number, title: node.title, state, queued: queued(number), waiting_on: waitingOn, unblocks: unblocks(number), priority: node.priority?.label ?? null, labels: [...node.labels].sort(), skipped_by: state === "skipped" ? (node.skipped ?? null) : null, claim };
  };
  const rank = (item: WaveIssue) => nodes.get(item.issue)?.priority?.rank ?? Number.MAX_SAFE_INTEGER;
  const order = (a: WaveIssue, b: WaveIssue) =>
    a.queued !== null && b.queued !== null
      ? a.queued - b.queued
      : a.queued !== null
        ? -1
        : b.queued !== null
          ? 1
          : rank(a) - rank(b) || b.unblocks - a.unblocks || a.issue - b.issue;
  const layers: WaveIssue[][] = [];
  const stuck: WaveIssue[] = [];
  for (const number of nodes.keys()) {
    const layer = waveOf(number);
    const item = entry(number, layer);
    if (layer === undefined) stuck.push(item);
    else (layers[layer - 1] ??= []).push(item);
  }
  return { waves: [...layers].map((layer) => (layer ?? []).sort(order)), stuck: stuck.sort(order), cycles };
};

/** Wave 1's dispatched issues, in order: what plain `next` and `claim --next` offer, claimed ones marked. */
export const frontier = (result: Waves): WaveIssue[] => (result.waves[0] ?? []).filter((item) => item.state === "workable" || item.state === "in_progress");
