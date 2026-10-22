/**
 * The timeline page (a prototype): `graph --json` as a table, one row per
 * issue and per blocker in another repository, with the `blocked_by` edges
 * drawn as lanes down the left, as `git log --graph` draws branches. Pure,
 * and the only layout: timeline-page.ts runs it in the browser whenever a
 * status is toggled, and scripts/timeline.ts bundles that page into the HTML.
 */
import type { GraphJson, IssueStatus } from "./graph.ts";
import { DEFAULT_PRIORITY_LABELS } from "./priority.ts";

type Issue = GraphJson["issues"][number];

/** A row: an issue of the graph, or a blocker in another repository (`repo` set, no `issue`). */
export type TimelineRow = {
  /** `#N`, or `owner/repo#N` for a blocker in another repository. */
  readonly key: string;
  readonly number: number;
  readonly repo: string | null;
  readonly issue: Issue | undefined;
  /** As its blocker entry says, for a row in another repository. */
  readonly open: boolean;
};

/** A `blocked_by` edge, from the blocker's row to the row it blocks; `lane` is null on the spine. */
export type TimelineEdge = { readonly from: number; readonly to: number; readonly open: boolean; readonly lane: number | null };

/** A lane: one source's edges, spanning its row and every target's. */
export type TimelineLane = { readonly lane: number; readonly source: number; readonly from: number; readonly to: number; readonly targets: readonly number[] };

/** Rows in order (a row's index is its node's place on the spine), the edges, and the lanes; `lanes` is the lane column's width. */
export type TimelineLayout = { readonly rows: readonly TimelineRow[]; readonly edges: readonly TimelineEdge[]; readonly lanes: number; readonly spans: readonly TimelineLane[] };

/** What a toggle hides: a status, or `external` for the rows in another repository. */
export type Hideable = IssueStatus | "external";

/** Every status, in the legend's order, with its colour; `merged` and `closed` are muted. */
export const STATUSES: readonly (readonly [IssueStatus, string])[] = [
  ["ready", "#1a7f37"],
  ["in_review", "#0969da"],
  ["claimed", "#bf8700"],
  ["workable", "#2aa198"],
  ["blocked", "#d4692b"],
  ["stuck", "#cf222e"],
  ["skipped", "#8250df"],
  ["not_dispatched", "#6e7781"],
  ["merged", "#a6a2c4"],
  ["closed", "#b4b8bd"],
];

export const HIDEABLE: readonly Hideable[] = [...STATUSES.map(([status]) => status), "external"];

const keyOf = (number: number, repo: string | null) => (repo === null ? `#${number}` : `${repo}#${number}`);

/**
 * Lays the graph out without the `hidden` rows and every edge to or from
 * them; a row in another repository shows while a shown issue lists it. Rows
 * go in Kahn's order over the `blocked_by` edges, every blocker above what it
 * blocks; of the rows free at once, the lowest milestone number goes first
 * (none last), then the highest priority label (none last), then the lowest
 * number. Cycle members, and whatever Kahn cannot place, come last by number.
 * A source whose only target is the next row joins it on the spine; any
 * other source takes the lowest lane free over its whole span, sources in
 * order of the span's first row.
 */
export const timelineLayout = (json: GraphJson, options: { readonly hidden?: ReadonlySet<Hideable> } = {}): TimelineLayout => {
  const hidden = options.hidden ?? new Set<Hideable>();
  const milestone = new Map(json.milestones.map((entry) => [entry.title, entry.number]));
  const shown = json.issues.filter((issue) => !hidden.has(issue.status));
  const rows: TimelineRow[] = shown.map((issue) => ({ key: keyOf(issue.issue, null), number: issue.issue, repo: null, issue, open: issue.state === "open" }));
  const index = new Map(rows.map((row, at) => [row.key, at]));
  for (const issue of hidden.has("external") ? [] : shown) {
    for (const blocker of issue.blocked_by) {
      if (blocker.repo === null || index.has(keyOf(blocker.issue, blocker.repo))) continue;
      index.set(keyOf(blocker.issue, blocker.repo), rows.length);
      rows.push({ key: keyOf(blocker.issue, blocker.repo), number: blocker.issue, repo: blocker.repo, issue: undefined, open: blocker.open });
    }
  }
  // Edges by the unordered rows' indexes; a blocker without a row (hidden, or missing from the graph) has no edge.
  const raw = new Map<string, { from: number; to: number; open: boolean }>();
  shown.forEach((issue, to) => {
    for (const blocker of issue.blocked_by) {
      const from = index.get(keyOf(blocker.issue, blocker.repo));
      if (from !== undefined) raw.set(`${from} ${to}`, { from, to, open: blocker.open });
    }
  });
  // A priority label the default list lacks ranks after it: the JSON carries no `queue.priority_labels`.
  const rank = (row: TimelineRow): readonly [number, number, number, string] => {
    const at = row.issue?.milestone == null ? undefined : milestone.get(row.issue.milestone);
    const priority = row.issue?.priority ?? null;
    const known = priority === null ? -1 : DEFAULT_PRIORITY_LABELS.indexOf(priority);
    return [at ?? Number.MAX_SAFE_INTEGER, priority === null ? Number.MAX_SAFE_INTEGER : known === -1 ? DEFAULT_PRIORITY_LABELS.length : known, row.number, row.repo ?? ""];
  };
  const before = (a: number, b: number) => {
    const [x, y] = [rank(rows[a] as TimelineRow), rank(rows[b] as TimelineRow)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : 0);
  };
  const waiting = rows.map(() => 0);
  const out = rows.map((): number[] => []);
  for (const edge of raw.values()) {
    waiting[edge.to] = (waiting[edge.to] as number) + 1;
    (out[edge.from] as number[]).push(edge.to);
  }
  const order: number[] = [];
  // A cycle's members wait on each other, so Kahn never frees them, nor what waits on them.
  const free = rows.map((_, at) => at).filter((at) => waiting[at] === 0);
  while (free.length > 0) {
    free.sort(before);
    const next = free.shift() as number;
    order.push(next);
    for (const to of out[next] as number[]) {
      waiting[to] = (waiting[to] as number) - 1;
      if (waiting[to] === 0) free.push(to);
    }
  }
  const placed = new Set(order);
  order.push(
    ...rows
      .map((_, at) => at)
      .filter((at) => !placed.has(at))
      .sort((a, b) => (rows[a] as TimelineRow).number - (rows[b] as TimelineRow).number || before(a, b)),
  );
  const position = new Map(order.map((at, row) => [at, row]));
  const ordered = order.map((at) => rows[at] as TimelineRow);
  const edges = [...raw.values()].map((edge) => ({ from: position.get(edge.from) as number, to: position.get(edge.to) as number, open: edge.open })).sort((a, b) => a.from - b.from || a.to - b.to);
  const targets = new Map<number, number[]>();
  for (const edge of edges) targets.set(edge.from, [...(targets.get(edge.from) ?? []), edge.to]);
  const spans: TimelineLane[] = [];
  const taken: { from: number; to: number }[][] = [];
  const sources = [...targets.entries()]
    .filter(([source, to]) => !(to.length === 1 && to[0] === source + 1))
    .map(([source, to]) => ({ source, targets: to, from: Math.min(source, ...to), to: Math.max(source, ...to) }))
    .sort((a, b) => a.from - b.from || a.source - b.source);
  for (const span of sources) {
    let lane = 0;
    while ((taken[lane] ?? []).some((other) => other.from <= span.to && span.from <= other.to)) lane++;
    (taken[lane] ??= []).push(span);
    spans.push({ lane, ...span });
  }
  const laneOf = new Map(spans.map((span) => [span.source, span.lane]));
  return { rows: ordered, edges: edges.map((edge) => ({ ...edge, lane: laneOf.get(edge.from) ?? null })), lanes: taken.length, spans };
};

export const ROW = 36;
const GAP = 10;
export const RADIUS = 4;

/** The lane column as SVG shapes: one path per edge, and each row's node. */
export type TimelineSvg = {
  readonly width: number;
  readonly height: number;
  readonly edges: readonly { readonly from: number; readonly to: number; readonly d: string }[];
  readonly nodes: readonly { readonly row: number; readonly cx: number; readonly cy: number }[];
};

/**
 * Every node on one spine at the column's right; lane 0 is the nearest to
 * it. No arrowheads: a blocker sits above what it blocks. A spine edge is a
 * short segment down; a lane edge leaves its source node to the left, runs
 * down (or up) its lane, and turns right into its own target, so the edges
 * of a source with several targets overlap on its lane.
 */
export const timelineSvg = (layout: TimelineLayout): TimelineSvg => {
  const spine = (layout.lanes + 1) * GAP + 4;
  const y = (row: number) => row * ROW + ROW / 2;
  const edges = layout.edges.map((edge) => {
    if (edge.lane === null) return { from: edge.from, to: edge.to, d: `M${spine} ${y(edge.from) + RADIUS}V${y(edge.to) - RADIUS}` };
    const x = spine - (edge.lane + 1) * GAP - 2;
    // A self-loop leaves just above the node's middle and comes back just below.
    const [from, to] = edge.from === edge.to ? [y(edge.from) - 2, y(edge.to) + 2] : [y(edge.from), y(edge.to)];
    const turn = Math.min(6, Math.abs(to - from) / 2);
    const down = to >= from ? 1 : -1;
    return { from: edge.from, to: edge.to, d: `M${spine - RADIUS} ${from}H${x + turn}Q${x} ${from} ${x} ${from + turn * down}V${to - turn * down}Q${x} ${to} ${x + turn} ${to}H${spine - RADIUS}` };
  });
  return { width: spine + RADIUS + 4, height: layout.rows.length * ROW, edges, nodes: layout.rows.map((_, row) => ({ row, cx: spine, cy: y(row) })) };
};

/** What hovering or pinning a row shows, by row key: the steps to it, what it unlocks, and what waits on it and on more besides. */
export type Focus = { readonly steps: ReadonlyMap<string, number | "cycle">; readonly unlocks: ReadonlyMap<string, number>; readonly waiting: ReadonlySet<string> };

/**
 * Each open issue's open blockers, and each key's open dependents, over the
 * whole graph: a hidden row or a blocker in another repository still blocks.
 * A blocker here is open as its own issue says, else as its entry says.
 */
const openGraph = (json: GraphJson) => {
  const here = new Map(json.issues.map((issue) => [keyOf(issue.issue, null), issue]));
  const blockers = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const issue of json.issues) {
    if (issue.state !== "open") continue;
    const open = issue.blocked_by.filter((blocker) => (blocker.repo === null ? (here.get(keyOf(blocker.issue, null))?.state ?? (blocker.open ? "open" : "closed")) === "open" : blocker.open));
    const keys = [...new Set(open.map((blocker) => keyOf(blocker.issue, blocker.repo)))];
    blockers.set(keyOf(issue.issue, null), keys);
    for (const key of keys) dependents.set(key, [...(dependents.get(key) ?? []), keyOf(issue.issue, null)]);
  }
  return { blockers: (key: string) => blockers.get(key) ?? [], dependents: (key: string) => dependents.get(key) ?? [] };
};

/** Every key reached from `start` by `next`, `start` left out. */
const walk = (start: string, next: (key: string) => readonly string[]): Set<string> => {
  const seen = new Set<string>();
  const todo = [start];
  for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
    for (const key of next(at)) {
      if (key === start || seen.has(key)) continue;
      seen.add(key);
      todo.push(key);
    }
  }
  return seen;
};

/**
 * The focus on `row`, over the whole graph's open issues.
 * - `steps`: its open ancestors (a closed blocker is done, so the walk stops
 *   there; an open blocker elsewhere is a leaf) in Kahn's waves: step 1 has
 *   no open blocker and can start now, step k waits only on steps below k,
 *   so a step is its longest open chain. What Kahn cannot place is `cycle`.
 * - `unlocks`: its descendants freed by it, in waves: ↓1 waits on nothing
 *   open but `row`, ↓k only on `row` and levels below k.
 * - `waiting`: its other open descendants, which wait on something more.
 * A row on both sides, through a cycle, is a step; `row` itself is a step,
 * `cycle`, only when it blocks itself.
 */
export const focus = (json: GraphJson, layout: TimelineLayout, row: number): Focus => {
  const start = layout.rows[row]?.key ?? "";
  const graph = openGraph(json);
  const ancestors = walk(start, graph.blockers);
  const steps = new Map<string, number | "cycle">();
  for (let step = 1; ; step++) {
    const wave = [...ancestors].filter((key) => !steps.has(key) && graph.blockers(key).every((blocker) => steps.has(blocker)));
    if (wave.length === 0) break;
    for (const key of wave) steps.set(key, step);
  }
  for (const key of ancestors) if (!steps.has(key)) steps.set(key, "cycle");
  // An issue that blocks itself is its own cycle.
  if (graph.blockers(start).includes(start)) steps.set(start, "cycle");
  const unlocks = new Map<string, number>();
  const freed = new Set([start]);
  for (let level = 1; ; level++) {
    const wave = [...new Set([...freed].flatMap(graph.dependents))].filter((key) => !freed.has(key) && !ancestors.has(key) && graph.blockers(key).every((blocker) => freed.has(blocker)));
    if (wave.length === 0) break;
    for (const key of wave) {
      unlocks.set(key, level);
      freed.add(key);
    }
  }
  const waiting = new Set([...walk(start, graph.dependents)].filter((key) => !unlocks.has(key) && !ancestors.has(key)));
  return { steps, unlocks, waiting };
};

/** The categorical palette's size: tones `c0`…`c5`, after Okabe–Ito without yellow. */
export const PALETTE = 6;

/**
 * Each level group of a focus, in order (step 1, step 2, …, `∞`, then ↓1,
 * ↓2, …), with its tone: the palette in order, cycling once it runs out.
 * Keys are `step 1`, `step ∞`, `unlock 1`.
 */
export const focusGroups = (seen: Focus): ReadonlyMap<string, string> => {
  const steps = [...seen.steps.values()];
  const deepest = Math.max(0, ...steps.filter((step): step is number => step !== "cycle"));
  const keys = [
    ...Array.from({ length: deepest }, (_, at) => `step ${at + 1}`),
    ...(steps.includes("cycle") ? ["step ∞"] : []),
    ...Array.from({ length: Math.max(0, ...seen.unlocks.values()) }, (_, at) => `unlock ${at + 1}`),
  ];
  return new Map(keys.map((key, at) => [key, `c${at % PALETTE}`]));
};

const groupOf = (seen: Focus, key: string): string | undefined => {
  const step = seen.steps.get(key);
  if (step !== undefined) return `step ${step === "cycle" ? "∞" : step}`;
  const level = seen.unlocks.get(key);
  return level === undefined ? undefined : `unlock ${level}`;
};

/** A badge in the depth column: its text, and its tone (a group's `c0`…`c5`, or `wait` for a row that waits on more). */
export type Badge = { readonly text: string; readonly tone: string };

/** The summary line as text and colour chips, each chip a group's tone. */
export type Summary = readonly (string | { readonly tone: string })[];

/**
 * What hovering (or pinning) `row` shows: each edge's classes, the rows that
 * fade, each related row's badge, and the summary line. Each level group has
 * its own colour (`focusGroups`); direction reads from the badge and from
 * position, and unlock edges are dashed.
 * - An edge from a step into a step or `row` is `blocker`, in its source's
 *   colour.
 * - An edge from `row` or an unlocked row into an unlocked row is `child`, in
 *   its source's colour (its target's, out of `row`).
 * - An edge from `row`, an unlocked row, or a waiting row into a waiting
 *   row stays plain grey.
 * - Every other edge, and every row but `row`, its steps, what it unlocks,
 *   and what waits on it, is `faded`.
 */
export const timelineHover = (
  json: GraphJson,
  layout: TimelineLayout,
  row: number,
): { readonly edges: readonly string[]; readonly faded: ReadonlySet<number>; readonly badges: ReadonlyMap<number, Badge>; readonly summary: Summary } => {
  const seen = focus(json, layout, row);
  const groups = focusGroups(seen);
  const key = (at: number) => layout.rows[at]?.key ?? "";
  const tone = (of: string) => groups.get(groupOf(seen, of) ?? "") ?? "";
  const start = key(row);
  const edges = layout.edges.map((edge) => {
    const [from, to] = [key(edge.from), key(edge.to)];
    if (seen.steps.has(from) && (to === start || seen.steps.has(to))) return `blocker ${tone(from)}`;
    if (seen.unlocks.has(to) && (from === start || seen.unlocks.has(from))) return `child ${tone(from === start ? to : from)}`;
    if (seen.waiting.has(to) && (from === start || seen.unlocks.has(from) || seen.waiting.has(from))) return "";
    return "faded";
  });
  const badges = new Map<number, Badge>();
  const faded = new Set<number>();
  layout.rows.forEach((entry, at) => {
    const step = seen.steps.get(entry.key);
    const level = seen.unlocks.get(entry.key);
    if (at === row) return;
    if (step !== undefined) badges.set(at, { text: step === "cycle" ? "∞" : String(step), tone: tone(entry.key) });
    else if (level !== undefined) badges.set(at, { text: `↓${level}`, tone: tone(entry.key) });
    else if (seen.waiting.has(entry.key)) badges.set(at, { text: "↓", tone: "wait" });
    else if (at !== row) faded.add(at);
  });
  return { edges, faded, badges, summary: focusSummary(start, seen) };
};

/** `#42: 3 steps (●2 ∥ ●1 ∥ ●3) · ●2 ∞ in a cycle · unlocks ●4 ●1`, each ● its group's colour chip. */
export const focusSummary = (key: string, seen: Focus): Summary => {
  const groups = focusGroups(seen);
  const count = (group: string) => [...seen.steps.keys(), ...seen.unlocks.keys()].filter((of) => groupOf(seen, of) === group).length;
  const chip = (group: string): Summary => [{ tone: groups.get(group) ?? "" }, String(count(group))];
  const steps = [...groups.keys()].filter((group) => group.startsWith("step ") && group !== "step ∞");
  const unlocks = [...groups.keys()].filter((group) => group.startsWith("unlock "));
  const parts: Summary[] = [
    ...(steps.length === 0 ? [] : [[`${steps.length} step${steps.length === 1 ? "" : "s"} (`, ...steps.flatMap((group, at) => [...(at === 0 ? [] : [" ∥ "]), ...chip(group)]), ")"]]),
    ...(groups.has("step ∞") ? [[...chip("step ∞"), " ∞ in a cycle"]] : []),
  ];
  const unlocked: Summary = unlocks.length === 0 ? ["unlocks 0"] : ["unlocks", ...unlocks.flatMap((group) => [" ", ...chip(group)])];
  return [`${key}: `, ...[...(parts.length === 0 ? [["nothing open blocks it"]] : parts), unlocked].flatMap((part, at) => [...(at === 0 ? [] : [" · "]), ...part])];
};

/** The summary as plain text, `●` for each chip. */
export const summaryText = (summary: Summary): string => summary.map((part) => (typeof part === "string" ? part : "●")).join("");

export const NONE = "—";

/** The URL when it is `https://github.com/`'s, the only kind the page links; otherwise null. */
export const githubUrl = (url: string | null | undefined): string | null => (typeof url === "string" && url.startsWith("https://github.com/") ? url : null);

/** A blocker in another repository's issue page, when `repo` reads as `owner/name`. */
export const externalUrl = (repo: string, number: number): string | null => (/^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/issues/${number}` : null);

/** `5m`, `3h`, or `2d` from `at` to `now`; `—` without a time. */
export const ago = (at: string | null | undefined, now: string): string => {
  if (at == null || at === "") return NONE;
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / 60_000));
  if (Number.isNaN(minutes)) return NONE;
  return minutes < 60 ? `${minutes}m` : minutes < 60 * 24 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60 / 24)}d`;
};

/** The text cells of an issue's row after its title: milestone, holder, claimed, quiet, and the pull request's state (after its `#N`). */
export const rowText = (issue: Issue, now: string): { readonly milestone: string; readonly holder: string; readonly claimed: string; readonly quiet: string; readonly pull: string } => {
  const claim = issue.claim;
  const quiet = claim === null ? null : [claim.created_at, claim.last_push_at, claim.last_comment_at].filter((at): at is string => typeof at === "string" && at !== "").sort().at(-1);
  const pr = issue.pr;
  const state = pr === null ? "" : pr.state !== "open" ? pr.state : pr.draft ? "draft" : `review ${pr.statuses["agent-review"] ?? NONE}`;
  return {
    milestone: issue.milestone ?? NONE,
    holder: claim === null ? NONE : (claim.family ?? claim.author ?? NONE),
    claimed: ago(claim?.created_at, now),
    quiet: ago(quiet, now),
    pull: pr === null ? NONE : [state, ...(pr.checks === null ? [] : [`checks ${pr.checks}`])].join(" · "),
  };
};

/** What the page keeps in its URL's hash: the hidden statuses, and the pinned row's key. */
export type PageState = { readonly hidden: ReadonlySet<Hideable>; readonly pin: string | undefined };

const decode = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
};

/** `#hide=merged,closed&pin=42` (`pin=` takes a row's key, `#` left off for an issue here); an unknown name or part is ignored. */
export const parseHash = (hash: string): PageState => {
  const parts = new Map(
    hash
      .replace(/^#/, "")
      .split("&")
      .filter((part) => part.includes("="))
      .map((part) => [part.slice(0, part.indexOf("=")), decode(part.slice(part.indexOf("=") + 1))] as const)
      .filter((part): part is readonly [string, string] => part[1] !== undefined),
  );
  const names = (parts.get("hide") ?? "").split(",");
  const pin = parts.get("pin");
  return { hidden: new Set(HIDEABLE.filter((name) => names.includes(name))), pin: pin === undefined || pin === "" ? undefined : /^\d+$/.test(pin) ? `#${pin}` : pin };
};

/** The hash for a state, statuses in the legend's order; empty for nothing hidden or pinned. */
export const stateHash = (state: PageState): string => {
  const names = HIDEABLE.filter((name) => state.hidden.has(name));
  const parts = [...(names.length === 0 ? [] : [`hide=${names.join(",")}`]), ...(state.pin === undefined ? [] : [`pin=${encodeURIComponent(state.pin.replace(/^#(?=\d+$)/, ""))}`])];
  return parts.length === 0 ? "" : `#${parts.join("&")}`;
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escapes `& < > " '`. */
export const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);

const UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");
/** The graph as JSON safe inside `<script type="application/json">`: `<`, `>`, `&`, U+2028, and U+2029 as `\uXXXX` escapes. */
export const scriptJson = (json: GraphJson): string => JSON.stringify(json).replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --text: #424a53; --muted: #6e7781; --bg: #f6f8fa; --surface: #ffffff; --line: #d8dee4; --band: rgba(191, 135, 0, 0.14); --edge: #8b949e; --c0: #c97f00; --c1: #2f8fcc; --c2: #00916a; --c3: #d55e00; --c4: #0064a3; --c5: #b85a93; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e6e6; --text: #b4b8bd; --muted: #7d8590; --bg: #0b0c0e; --surface: #17181b; --line: #26282c; --band: rgba(210, 170, 60, 0.16); --c0: #f0a830; --c1: #74c8f2; --c2: #2fc496; --c3: #f27a3c; --c4: #6f95ff; --c5: #e48fc3; } }
body { margin: 0; padding: 16px; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); background: var(--bg); }
main { display: inline-block; min-width: min(100%, 960px); background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; box-sizing: border-box; }
h1 { font-size: 15px; font-weight: 600; color: var(--fg); margin: 0 0 4px; }
.meta { color: var(--muted); margin: 2px 0; }
.legend label { margin-right: 12px; white-space: nowrap; cursor: pointer; }
.legend input { margin: 0 4px 0 0; vertical-align: -2px; }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; }
table { border-collapse: separate; border-spacing: 0; margin-top: 12px; }
th { text-align: left; font-weight: 500; color: var(--muted); padding: 4px 10px; white-space: nowrap; }
td { height: ${ROW}px; padding: 0 10px; white-space: nowrap; }
th.time, td.time { text-align: right; font-variant-numeric: tabular-nums; }
td.lanes { padding: 0; vertical-align: top; line-height: 0; }
td.title { color: var(--fg); padding-left: 6px; }
td.num { color: var(--muted); padding-right: 0; font-variant-numeric: tabular-nums; }
td.depth { min-width: 2.2em; padding: 0 0 0 4px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
tbody tr { cursor: default; }
tr.hi td:not(.lanes) { background: var(--band); }
tr.hi td:last-child { border-radius: 0 6px 6px 0; }
tr.faded td:not(.lanes), .edge.faded, .node.faded { opacity: 0.5; }
.band { fill: transparent; }
.band.on { fill: var(--band); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: 0; }
svg { display: block; }
svg.ring { display: inline; vertical-align: -1px; margin-right: 4px; }
.edge { fill: none; stroke: var(--edge); stroke-width: 1.25; }
.edge.blocker, .edge.child { stroke-width: 2; }
.edge.child { stroke-dasharray: 5 3; }
.node { stroke: var(--surface); stroke-width: 1.5; }
.node.foreign { fill: var(--surface); stroke: var(--muted); stroke-dasharray: 2 1.5; }
.node.foreign.shut { fill: var(--line); }
${Array.from({ length: PALETTE }, (_, at) => `c${at}`).map((tone) => `.edge.${tone} { stroke: var(--${tone}); } .node.${tone} { fill: var(--${tone}); } td.${tone} { color: var(--${tone}); } .dot.${tone} { background: var(--${tone}); }`).join("\n")}
.node.wait { fill: var(--edge); }
td.depth:not(.wait) { font-weight: 600; }
.focus .dot { margin: 0 3px 0 0; }
${STATUSES.map(([status, colour]) => `.s-${status} { fill: ${colour}; background: ${colour}; }`).join("\n")}
`;

/**
 * The page: the graph as escaped JSON, and `script`, timeline-page.ts's
 * bundle, which renders it with DOM APIs. Static; it loads nothing remote.
 */
export const timelineHtml = (json: GraphJson, script: string): string => {
  if (/<\/script/i.test(script)) throw new Error("timeline: the page's bundle contains </script");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(String(json.repo))} timeline</title>
<style>${STYLE}</style>
</head>
<body>
<noscript>The timeline is drawn by its script.</noscript>
<script type="application/json" id="graph">${scriptJson(json)}</script>
<script type="module">${script}</script>
</body>
</html>
`;
};
