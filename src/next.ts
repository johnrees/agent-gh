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
 * scheduler.
 */
import type { Claim } from "./claim.ts";

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
  /** Its highest priority label, and that label's rank (0 highest); undefined for none. */
  readonly priority?: { readonly label: string; readonly rank: number };
};

export type GraphInput = {
  /** The Queue's order, or undefined when no queue is configured. */
  readonly queue: readonly number[] | undefined;
  /** Every open issue of this repository in the graph, by number. Closed ones are left out: they block nothing. */
  readonly nodes: ReadonlyMap<number, Node>;
};

export type IssueState = "workable" | "in_progress" | "not_dispatched" | "waiting";

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
    const state: IssueState = layer !== 1 ? "waiting" : !node.dispatched ? "not_dispatched" : node.claim !== undefined ? "in_progress" : "workable";
    const claim = node.claim === undefined ? null : { kind: node.claim.kind, pr: node.claim.pr, url: node.claim.url, family: node.claim.family, session: node.claim.session };
    return { issue: number, title: node.title, state, queued: queued(number), waiting_on: waitingOn, unblocks: unblocks(number), priority: node.priority?.label ?? null, claim };
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
