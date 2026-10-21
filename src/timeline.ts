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

export const ROW = 26;
const GAP = 8;
export const RADIUS = 4.5;
const ARROW = 4;

/** The lane column as SVG shapes: each edge's path and arrowhead, and each row's node. */
export type TimelineSvg = {
  readonly width: number;
  readonly height: number;
  readonly edges: readonly { readonly from: number; readonly to: number; readonly open: boolean; readonly d: string; readonly arrow: string }[];
  readonly nodes: readonly { readonly row: number; readonly cx: number; readonly cy: number }[];
};

/**
 * Every node on one spine at the column's right; lane 0 is the nearest to
 * it. A spine edge is a short arrow down; a lane edge leaves its node to the
 * left, runs down (or up) its lane, and turns right into the target.
 */
export const timelineSvg = (layout: TimelineLayout): TimelineSvg => {
  const spine = (layout.lanes + 1) * GAP + 4;
  const y = (row: number) => row * ROW + ROW / 2;
  const tip = spine - RADIUS - 1;
  const edges = layout.edges.map((edge) => {
    if (edge.lane === null) {
      const end = y(edge.to) - RADIUS - 1;
      return { from: edge.from, to: edge.to, open: edge.open, d: `M${spine} ${y(edge.from) + RADIUS + 1}V${end - ARROW}`, arrow: `${spine},${end} ${spine - 3},${end - ARROW} ${spine + 3},${end - ARROW}` };
    }
    const x = spine - (edge.lane + 1) * GAP - 2;
    // A self-loop leaves just above the node's middle and comes back just below.
    const [from, to] = edge.from === edge.to ? [y(edge.from) - 2, y(edge.to) + 2] : [y(edge.from), y(edge.to)];
    const turn = Math.min(4, Math.abs(to - from) / 2);
    const down = to >= from ? 1 : -1;
    return {
      from: edge.from, to: edge.to, open: edge.open,
      d: `M${spine - RADIUS} ${from}H${x + turn}Q${x} ${from} ${x} ${from + turn * down}V${to - turn * down}Q${x} ${to} ${x + turn} ${to}H${tip - ARROW}`,
      arrow: `${tip},${to} ${tip - ARROW},${to - 3} ${tip - ARROW},${to + 3}`,
    };
  });
  return { width: spine + RADIUS + 4, height: layout.rows.length * ROW, edges, nodes: layout.rows.map((_, row) => ({ row, cx: spine, cy: y(row) })) };
};

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

/** `#hide=merged,closed` as a set; an unknown name is ignored. */
export const parseHide = (hash: string): Set<Hideable> => {
  const match = /^#?hide=(.*)$/.exec(hash);
  if (match === null) return new Set();
  let names: string;
  try {
    names = decodeURIComponent(match[1] as string);
  } catch {
    return new Set();
  }
  return new Set(HIDEABLE.filter((name) => names.split(",").includes(name)));
};

/** The hash for a hidden set, in the legend's order; empty for none. */
export const hideHash = (hidden: ReadonlySet<Hideable>): string => {
  const names = HIDEABLE.filter((name) => hidden.has(name));
  return names.length === 0 ? "" : `#hide=${names.join(",")}`;
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escapes `& < > " '`. */
export const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string);

const UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");
/** The graph as JSON safe inside `<script type="application/json">`: `<`, `>`, `&`, U+2028, and U+2029 as `\uXXXX` escapes. */
export const scriptJson = (json: GraphJson): string => JSON.stringify(json).replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #656d76; --bg: #ffffff; --line: #d0d7de; --hover: #f3f6fa; --edge: #8c959f; --hi: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #8d96a0; --bg: #0d1117; --line: #30363d; --hover: #161b22; --edge: #6e7681; --hi: #4493f8; } }
body { margin: 16px; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
h1 { font-size: 15px; margin: 0 0 4px; }
.meta { color: var(--muted); margin: 2px 0; }
.legend label { margin-right: 12px; white-space: nowrap; cursor: pointer; }
.legend input { margin: 0 4px 0 0; vertical-align: -2px; }
a { color: inherit; }
table { border-collapse: collapse; margin-top: 12px; }
th { text-align: left; font-weight: 600; color: var(--muted); padding: 4px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { height: ${ROW}px; padding: 0 10px; white-space: nowrap; box-shadow: inset 0 -1px var(--line); }
td.lanes { padding: 0; vertical-align: top; box-shadow: none; line-height: 0; }
td.num { color: var(--muted); padding-right: 0; }
tr.hi td:not(.lanes) { background: var(--hover); }
tr.rel td:not(.lanes) { background: color-mix(in srgb, var(--hover) 50%, transparent); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 0; }
svg { display: block; }
svg.ring { display: inline; vertical-align: -1px; margin-right: 4px; }
.edge { color: var(--edge); }
.edge path { fill: none; stroke: currentColor; stroke-width: 1.25; }
.edge polygon { fill: currentColor; }
.edge.done { opacity: 0.45; }
.edge.hi { color: var(--hi); opacity: 1; }
.edge.hi path { stroke-width: 2; }
.node { stroke: var(--bg); stroke-width: 1.5; }
.node.foreign { fill: var(--bg); stroke: var(--muted); stroke-dasharray: 2 1.5; }
.node.foreign.shut { fill: var(--line); }
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
