/// <reference lib="dom" />
/**
 * The timeline page's script, bundled into the page by scripts/timeline.ts:
 * reads the graph from its JSON script element and draws it with DOM APIs,
 * every string from the JSON as `textContent`. A legend checkbox hides a
 * status (or the rows in another repository) and lays the rest out again;
 * the URL's hash keeps the choice.
 */
import type { GraphJson } from "./graph.ts";
import { externalUrl, githubUrl, type Hideable, hideHash, NONE, parseHide, RADIUS, rowText, STATUSES, timelineLayout, timelineSvg } from "./timeline.ts";

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

let hidden = parseHide(location.hash);
const counts = new Map<Hideable, number>();
for (const issue of json.issues) counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
counts.set("external", new Set(json.issues.flatMap((issue) => issue.blocked_by.filter((blocker) => blocker.repo !== null).map((blocker) => `${blocker.repo}#${blocker.issue}`))).size);

const summary = element("p", { class: "meta" });
const boxes = new Map<Hideable, HTMLInputElement>();
const toggle = (name: Hideable, label: (Node | string)[]) => {
  const box = element("input", { type: "checkbox" });
  box.addEventListener("change", () => {
    const next = new Set(hidden);
    if (box.checked) next.delete(name);
    else next.add(name);
    const hash = hideHash(next);
    history.replaceState(null, "", hash === "" ? location.pathname + location.search : hash);
    hidden = next;
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
const head = element("tr", {}, ...["", "Issue", "Status", "Milestone", "Holder", "Claimed", "Quiet", "Pull request"].map((name, at) => element("th", at === 1 ? { colspan: "2" } : {}, name)));
const body = element("tbody");
document.body.append(
  element("h1", {}, String(json.repo)),
  summary,
  legend,
  element("p", { class: "meta" }, `stuck: ${list(json.stuck)} · cycles: ${json.cycles.length === 0 ? NONE : json.cycles.map(list).join("; ")}`),
  element("table", {}, element("thead", {}, head), body),
);

function draw() {
  for (const [name, box] of boxes) box.checked = !hidden.has(name);
  const layout = timelineLayout(json, { hidden });
  const drawn = timelineSvg(layout);
  summary.textContent = `fetched ${json.fetched_at} · ${layout.rows.length} rows · ${layout.lanes} lanes`;
  const svg = shape(
    "svg",
    { width: drawn.width, height: drawn.height, viewBox: `0 0 ${drawn.width} ${drawn.height}`, "aria-hidden": "true" },
    ...drawn.edges.map((edge) => shape("g", { class: `edge${edge.open ? "" : " done"}`, "data-from": edge.from, "data-to": edge.to }, shape("path", { d: edge.d }), shape("polygon", { points: edge.arrow }))),
    ...drawn.nodes.map((node) => {
      const row = layout.rows[node.row];
      const kind = row?.issue === undefined ? `foreign${row?.open ? "" : " shut"}` : `s-${row.issue.status}`;
      return shape("circle", { class: `node ${kind}`, "data-row": node.row, cx: node.cx, cy: node.cy, r: RADIUS });
    }),
  );
  body.replaceChildren(
    ...layout.rows.map((row, at) => {
      const cells: HTMLElement[] = at === 0 ? [element("td", { class: "lanes", rowspan: String(layout.rows.length) }, svg)] : [];
      const issue = row.issue;
      if (issue === undefined) {
        cells.push(element("td", { class: "num" }), element("td", {}, link(row.repo === null ? null : externalUrl(row.repo, row.number), row.key)), ...Array.from({ length: 6 }, () => element("td", {}, NONE)));
      } else {
        const text = rowText(issue, json.fetched_at);
        cells.push(
          element("td", { class: "num" }, link(issue.url, `#${issue.issue}`)),
          element("td", {}, link(issue.url, issue.title)),
          element("td", {}, dot(issue.status), words(issue.status)),
          element("td", {}, text.milestone),
          element("td", {}, text.holder),
          element("td", {}, text.claimed),
          element("td", {}, text.quiet),
          element("td", {}, ...(issue.pr === null ? [NONE] : [link(issue.pr.url, `#${issue.pr.number}`), ` · ${text.pull}`])),
        );
      }
      return element("tr", { "data-row": String(at), "data-key": row.key, "data-status": issue?.status ?? "" }, ...cells);
    }),
  );
}

// Hovering a row, or its node, lights the row, its edges in and out, and the rows at their other ends.
const light = (at: string, on: boolean) => {
  const rows = body.children;
  rows[Number(at)]?.classList.toggle("hi", on);
  for (const edge of body.querySelectorAll<SVGGElement>(".edge")) {
    const { from, to } = edge.dataset;
    if (from !== at && to !== at) continue;
    edge.classList.toggle("hi", on);
    if (on) edge.parentNode?.insertBefore(edge, edge.parentNode.querySelector("circle"));
    rows[Number(from === at ? to : from)]?.classList.toggle("rel", on);
  }
};
const rowOf = (event: Event): string | undefined => {
  const target = event.target instanceof Element ? event.target : null;
  const node = target?.closest<SVGElement>("circle[data-row]");
  if (node !== null && node !== undefined) return node.dataset.row;
  return target?.closest("td.lanes") ? undefined : target?.closest<HTMLElement>("tbody tr")?.dataset.row;
};
document.addEventListener("mouseover", (event) => {
  const at = rowOf(event);
  if (at !== undefined) light(at, true);
});
document.addEventListener("mouseout", (event) => {
  const at = rowOf(event);
  if (at !== undefined) light(at, false);
});
addEventListener("hashchange", () => {
  hidden = parseHide(location.hash);
  draw();
});
draw();
