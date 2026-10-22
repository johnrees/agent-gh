/// <reference lib="dom" />
/**
 * The timeline page's script, bundled into the page by scripts/timeline.ts:
 * reads the graph from its JSON script element and draws it with DOM APIs,
 * every string from the JSON as `textContent`. A legend checkbox hides a
 * status (or the rows in another repository) and lays the rest out again.
 * Hovering a row shows its chain of blockers in red and of dependents in
 * green, each row with its distance; clicking pins that. The URL's hash
 * keeps the toggles and the pin.
 */
import type { GraphJson } from "./graph.ts";
import { externalUrl, githubUrl, type Hideable, NONE, type PageState, parseHash, RADIUS, ROW, rowText, STATUSES, stateHash, timelineHover, timelineLayout, timelineSvg } from "./timeline.ts";

const SVG = "http://www.w3.org/2000/svg";
const json = JSON.parse(document.getElementById("graph")?.textContent ?? "null") as GraphJson;

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, value);
  made.append(...children);
  return made;
};
const shape = (tag: string, attributes: Record<string, string | number>, ...children: Node[]): SVGElement => {
  const made = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, String(value));
  made.append(...children);
  return made;
};
/** A link only to `https://github.com/`; any other URL is plain text. */
const link = (url: string | null, text: string): Node | string => {
  const safe = githubUrl(url);
  return safe === null ? text : element("a", { href: safe }, text);
};
const dot = (status: string) => element("span", { class: `dot s-${status}` });
const ring = (open: boolean) => shape("svg", { class: "ring", width: 12, height: 12 }, shape("circle", { class: `node foreign${open ? "" : " shut"}`, cx: 6, cy: 6, r: RADIUS }));
const words = (status: string) => status.replace("_", " ");

let state: PageState = parseHash(location.hash);
const save = (next: PageState) => {
  state = next;
  const hash = stateHash(next);
  history.replaceState(null, "", hash === "" ? location.pathname + location.search : hash);
};

const counts = new Map<Hideable, number>();
for (const issue of json.issues) counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
counts.set("external", new Set(json.issues.flatMap((issue) => issue.blocked_by.filter((blocker) => blocker.repo !== null).map((blocker) => `${blocker.repo}#${blocker.issue}`))).size);

const summary = element("p", { class: "meta" });
const boxes = new Map<Hideable, HTMLInputElement>();
const toggle = (name: Hideable, label: (Node | string)[]) => {
  const box = element("input", { type: "checkbox" });
  box.addEventListener("change", () => {
    const hidden = new Set(state.hidden);
    if (box.checked) hidden.delete(name);
    else hidden.add(name);
    save({ ...state, hidden });
    draw();
  });
  boxes.set(name, box);
  return element("label", {}, box, ...label);
};
const legend = element(
  "p",
  { class: "meta legend" },
  ...STATUSES.map(([status]) => toggle(status, [dot(status), `${words(status)} ${counts.get(status) ?? 0}`])),
  toggle("external", [ring(true), `other repos ${counts.get("external") ?? 0}`]),
);
const list = (numbers: readonly number[]) => (numbers.length === 0 ? NONE : numbers.map((number) => `#${number}`).join(", "));
const COLUMNS: readonly (readonly [string, string])[] = [
  ["", ""],
  ["", ""],
  ["Issue", ""],
  ["Status", ""],
  ["Milestone", ""],
  ["Holder", ""],
  ["Claimed", "time"],
  ["Quiet", "time"],
  ["Pull request", ""],
];
const head = element("tr", {}, ...COLUMNS.map(([name, kind]) => element("th", { ...(name === "Issue" ? { colspan: "2" } : {}), ...(kind === "" ? {} : { class: kind }) }, name)));
const body = element("tbody");
const HINT = "hover a row for the steps to it and what it unlocks; click to pin, Escape to unpin";
const focusLine = element("p", { class: "meta focus" }, HINT);
document.body.append(
  element(
    "main",
    {},
    element("h1", {}, String(json.repo)),
    summary,
    legend,
    element("p", { class: "meta" }, `stuck: ${list(json.stuck)} · cycles: ${json.cycles.length === 0 ? NONE : json.cycles.map(list).join("; ")}`),
    focusLine,
    element("table", {}, element("thead", {}, head), body),
  ),
);

let layout = timelineLayout(json);
let edges: SVGElement[] = [];
let nodes: SVGElement[] = [];
let band: SVGElement | undefined;
let lit: number | undefined | null = null;

function draw() {
  for (const [name, box] of boxes) box.checked = !state.hidden.has(name);
  layout = timelineLayout(json, { hidden: state.hidden });
  lit = null;
  const drawn = timelineSvg(layout);
  summary.textContent = `fetched ${json.fetched_at} · ${layout.rows.length} rows · ${layout.lanes} lanes`;
  band = shape("rect", { class: "band", x: 0, y: 0, width: drawn.width, height: ROW });
  edges = drawn.edges.map((edge) => shape("path", { class: "edge", "data-from": edge.from, "data-to": edge.to, d: edge.d }));
  nodes = drawn.nodes.map((node) => {
    const row = layout.rows[node.row];
    const kind = row?.issue === undefined ? `foreign${row?.open ? "" : " shut"}` : `s-${row.issue.status}`;
    return shape("circle", { class: `node ${kind}`, "data-row": node.row, cx: node.cx, cy: node.cy, r: RADIUS });
  });
  const svg = shape("svg", { width: drawn.width, height: drawn.height, viewBox: `0 0 ${drawn.width} ${drawn.height}`, "aria-hidden": "true" }, band, shape("g", {}, ...edges), ...nodes);
  body.replaceChildren(
    ...layout.rows.map((row, at) => {
      const cells: HTMLElement[] = at === 0 ? [element("td", { class: "lanes", rowspan: String(layout.rows.length) }, svg)] : [];
      cells.push(element("td", { class: "depth" }));
      const issue = row.issue;
      if (issue === undefined) {
        cells.push(
          element("td", { class: "num" }),
          element("td", { class: "title" }, link(row.repo === null ? null : externalUrl(row.repo, row.number), row.key)),
          ...COLUMNS.slice(3).map(([, kind]) => element("td", kind === "" ? {} : { class: kind }, NONE)),
        );
      } else {
        const text = rowText(issue, json.fetched_at);
        cells.push(
          element("td", { class: "num" }, link(issue.url, `#${issue.issue}`)),
          element("td", { class: "title" }, link(issue.url, issue.title)),
          element("td", {}, dot(issue.status), words(issue.status)),
          element("td", {}, text.milestone),
          element("td", {}, text.holder),
          element("td", { class: "time" }, text.claimed),
          element("td", { class: "time" }, text.quiet),
          element("td", {}, ...(issue.pr === null ? [NONE] : [link(issue.pr.url, `#${issue.pr.number}`), ` · ${text.pull}`])),
        );
      }
      return element("tr", { "data-row": String(at), "data-key": row.key, "data-status": issue?.status ?? "" }, ...cells);
    }),
  );
  light(pinned() ?? undefined);
}

/** The pinned row's index, or undefined when nothing is pinned or the pinned row is hidden. */
const pinned = (): number | undefined => {
  const at = state.pin === undefined ? -1 : layout.rows.findIndex((row) => row.key === state.pin);
  return at === -1 ? undefined : at;
};

const TONES = ["blocker", "child", "faded", "r1", "r2", "r3", "g1", "g2", "g3", "wait"];

// Lights a row's focus: the steps to it in red, what it unlocks in green, each shaded by level with its badge, what waits on more in grey, and the rest faded.
function light(row: number | undefined) {
  if (row === lit) return;
  lit = row;
  const hover = row === undefined ? undefined : timelineHover(json, layout, row);
  focusLine.textContent = hover?.summary ?? HINT;
  [...body.children].forEach((tr, at) => {
    const badge = hover?.badges.get(at);
    const faded = hover?.faded.has(at) ?? false;
    tr.classList.toggle("hi", at === row);
    tr.classList.toggle("faded", faded);
    const depth = tr.querySelector("td.depth");
    if (depth !== null) {
      depth.className = badge === undefined ? "depth" : `depth ${badge.tone}`;
      depth.textContent = badge?.text ?? "";
    }
    nodes[at]?.classList.remove(...TONES);
    if (faded) nodes[at]?.classList.add("faded");
    if (badge !== undefined) nodes[at]?.classList.add(badge.tone);
  });
  band?.setAttribute("y", String((row ?? 0) * ROW));
  band?.classList.toggle("on", row !== undefined);
  edges.forEach((edge, at) => {
    const names = (hover?.edges[at] ?? "").split(" ").filter((name) => name !== "");
    edge.classList.remove(...TONES);
    edge.classList.add(...names);
    // Coloured edges go above the grey and faded ones.
    if (names.includes("blocker") || names.includes("child")) edge.parentNode?.appendChild(edge);
  });
}

const rowOf = (event: Event): number | undefined => {
  const target = event.target instanceof Element ? event.target : null;
  const node = target?.closest<SVGElement>("circle[data-row]");
  const at = node !== null && node !== undefined ? node.dataset.row : target?.closest("td.lanes") ? undefined : target?.closest<HTMLElement>("tbody tr")?.dataset.row;
  return at === undefined ? undefined : Number(at);
};
document.addEventListener("mouseover", (event) => {
  if (pinned() === undefined) light(rowOf(event));
});
document.documentElement.addEventListener("mouseleave", () => {
  if (pinned() === undefined) light(undefined);
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("a") !== null) return;
  const at = rowOf(event);
  if (at === undefined) return;
  const key = layout.rows[at]?.key;
  save({ ...state, pin: key === state.pin ? undefined : key });
  lit = null;
  light(pinned() ?? at);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || state.pin === undefined) return;
  save({ ...state, pin: undefined });
  lit = null;
  light(undefined);
});
addEventListener("hashchange", () => {
  state = parseHash(location.hash);
  draw();
});
draw();
