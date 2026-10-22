/**
 * `agent-gh graph --html`: one self-contained page of the graph, the
 * flowchart drawn in the browser by Pele from a CDN at a pinned version, with
 * the JSON beside it for each node's tooltip, and a meta refresh so a file a
 * loop rewrites keeps a tab live. Pure. The page writes nothing and talks to
 * nothing but the CDN; its CSP allows that one script and its own inline
 * script and style, by hash.
 */
import { createHash } from "node:crypto";
import type { GraphJson, IssueStatus } from "./graph.ts";
import { STATUS_STYLES } from "./graph-mermaid.ts";

/** Pele 1.8.0's browser bundle on jsDelivr, and its SRI hash (the npm tarball's file hashes the same). */
export const PELE_URL = "https://cdn.jsdelivr.net/npm/pele@1.8.0/dist/pele.global.js";
export const PELE_INTEGRITY = "sha384-O0f2P/Pw3prXhKY40670AJnzaxOfKSSWDrQd0uNfnc8gb0tCZeM+x8L5HixJKF9u";

/** The refresh interval without `--every`, in seconds. */
export const DEFAULT_EVERY = 60;

const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON that cannot leave its `<script>`: `<`, `>`, and `&` as JSON escapes. */
export const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** A classDef's `fill`, `stroke`, and `color` as CSS for the legend's swatches. */
const swatch = (style: string): string =>
  style
    .split(",")
    .map((part) => part.split(":") as [string, string])
    .map(([key, value]) => `${key === "fill" ? "background" : key === "stroke" ? "border-color" : key}:${value}`)
    .join(";");

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--warn:#9a6700;--warn-bg:#fff8c5}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--warn:#d29922;--warn-bg:#2e2a1f}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline}
h1{font-size:18px;margin:0}
#fetched{color:var(--muted)}
#stale{display:none;padding:4px 8px;border-radius:4px;background:var(--warn-bg);color:var(--warn);font-weight:600}
.stale #stale{display:inline-block}
.legend{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0;padding:0;list-style:none}
.legend li{padding:1px 8px;border:1px solid;border-radius:4px;font-size:12px}
#diagram{overflow-x:auto;--pele-bg:var(--bg);--pele-fg:var(--fg);--pele-muted:var(--muted);--pele-line:var(--muted);--pele-border:var(--line)}
@media (prefers-color-scheme:dark){#diagram{--pele-surface:#151b23;--pele-surface-alt:#212830}}
#diagram .pele-node.clickable{cursor:pointer}
.drawn #fallback{display:none}
#fallback pre{overflow-x:auto;padding:8px;border:1px solid var(--line);border-radius:4px;font-size:12px}
#tooltip{position:fixed;z-index:1;max-width:min(420px,calc(100vw - 32px));padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);box-shadow:0 4px 12px rgba(0,0,0,.2);font-size:12px;pointer-events:none}
#tooltip div:first-child{font-weight:600}
${Object.entries(STATUS_STYLES)
  .map(([status, style]) => `.legend .${status}{${swatch(style)}}`)
  .join("\n")}
.legend .outside{border-style:dashed}
`;

/**
 * A node's tooltip, as lines of text: the issue's title, status, and
 * milestone; for a claim its holder, how long ago it was claimed, and how
 * long it has been quiet, as of `fetched_at`; its pull request's statuses
 * and checks; what skips and blocks it. A blocker in another repository is
 * found by its link, since two repositories can spell one node id. The page
 * runs this function's own source, so it uses nothing outside itself.
 */
export function tooltipLines(data: GraphJson, id: string | null, href: string | null): string[] {
  const span = (ms: number) => {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
  };
  const at = (time: string | null) => (time === null || time === "" ? Number.NaN : Date.parse(time));
  const fetched = Date.parse(data.fetched_at);
  const issue = data.issues.find((item) => `i${item.issue}` === id);
  if (issue === undefined) {
    for (const item of data.issues) {
      for (const blocker of item.blocked_by) {
        if (blocker.repo !== null && href === `https://github.com/${blocker.repo}/issues/${blocker.issue}`) {
          return [`${blocker.repo}#${blocker.issue}`, `${blocker.open ? "open" : "closed"}, in another repository`];
        }
      }
    }
    return [];
  }
  const found = [`#${issue.issue} ${issue.title}`, `${issue.status.replace("_", " ")}${issue.milestone === null ? "" : ` · ${issue.milestone}`}`];
  const claim = issue.claim;
  if (claim !== null) {
    found.push(`held by ${claim.family === null ? claim.author : `${claim.family} (${claim.author})`}`);
    const created = at(claim.created_at);
    const last = Math.max(...[claim.created_at, claim.last_push_at, claim.last_comment_at].map(at).filter((time) => !Number.isNaN(time)));
    if (!Number.isNaN(created)) found.push(`claimed ${span(fetched - created)} ago`);
    if (Number.isFinite(last)) found.push(`quiet ${span(fetched - last)}`);
  }
  const pr = issue.pr;
  if (pr !== null) {
    found.push(`pull request #${pr.number} ${pr.draft ? "draft" : pr.state}${pr.review_decision === null ? "" : `, ${pr.review_decision.replace("_", " ")}`}`);
    if (pr.state === "open") {
      const named = (context: string) => pr.statuses[context] ?? "unset";
      found.push(`agent-review ${named("agent-review")} · agent-threads ${named("agent-threads")} · agent-hold ${named("agent-hold")}`);
      found.push(`checks ${pr.checks ?? "none required"}`);
    }
  }
  if (issue.skipped_by !== null) found.push(`skipped by ${issue.skipped_by.rule}: ${issue.skipped_by.label ?? issue.skipped_by.pattern}`);
  if (issue.blocked_by.length > 0) found.push(`blocked by ${issue.blocked_by.map((blocker) => `${blocker.repo ?? ""}#${blocker.issue}${blocker.open ? "" : " (closed)"}`).join(", ")}`);
  return found;
}

/** The page's own script: draw with Pele where it loaded, keep the text where not, mark staleness, and show each node's tooltip from the JSON. */
const SCRIPT = `
"use strict";
(() => {
  const data = JSON.parse(document.getElementById("graph").textContent);
  const source = document.getElementById("source").textContent;
  const every = Number(document.body.dataset.every) * 1000;
  const fetched = Date.parse(data.fetched_at);
  const span = (ms) => {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? hours + "h " + (minutes % 60) + "m" : Math.floor(hours / 24) + "d " + (hours % 24) + "h";
  };
  const stamp = document.getElementById("fetched");
  const tick = () => {
    const age = Date.now() - fetched;
    stamp.textContent = "fetched " + data.fetched_at + " (" + span(age) + " ago)";
    document.body.classList.toggle("stale", age > 3 * every);
  };
  tick();
  setInterval(tick, 10000);

  const diagram = document.getElementById("diagram");
  if (typeof pele === "object" && pele !== null && typeof pele.mount === "function") {
    try {
      const mounted = pele.mount(diagram, source, { zoom: false });
      if (mounted.error === undefined || mounted.error === null) document.body.classList.add("drawn");
    } catch (error) {
      diagram.textContent = "";
    }
  }
  diagram.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (link === null || !/^https:\\/\\/github\\.com\\//.test(link.getAttribute("href"))) return;
    event.preventDefault();
    window.open(link.getAttribute("href"), "_blank", "noopener");
  });

  const tooltipLines = ${tooltipLines.toString()};
  const lines = (node) => {
    const link = node.querySelector("a[href]");
    return tooltipLines(data, node.getAttribute("data-id"), link === null ? null : link.getAttribute("href"));
  };
  const tooltip = document.getElementById("tooltip");
  const show = (node, x, y) => {
    const text = lines(node);
    if (text.length === 0) return;
    tooltip.replaceChildren(...text.map((line) => {
      const row = document.createElement("div");
      row.textContent = line;
      return row;
    }));
    tooltip.hidden = false;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    tooltip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - width - 8)) + "px";
    tooltip.style.top = Math.max(8, y + 16 + height > window.innerHeight ? y - height - 8 : y + 16) + "px";
  };
  diagram.addEventListener("pointermove", (event) => {
    const node = event.target.closest(".pele-node");
    if (node === null) tooltip.hidden = true;
    else show(node, event.clientX, event.clientY);
  });
  diagram.addEventListener("pointerleave", () => { tooltip.hidden = true; });
  diagram.addEventListener("focusin", (event) => {
    const node = event.target.closest(".pele-node");
    if (node === null) return;
    const box = node.getBoundingClientRect();
    show(node, box.left, box.bottom);
  });
  diagram.addEventListener("focusout", () => { tooltip.hidden = true; });
})();
`;

/** The CSP: Pele's one URL and the page's own script by hash; its own `<style>` by hash, and Pele's SVG style attributes. */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${PELE_URL} ${sha256(SCRIPT)}`,
  "style-src 'unsafe-inline'",
  `style-src-elem ${sha256(STYLE)}`,
  "style-src-attr 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type PageOptions = {
  /** The flowchart, as `graphMermaid` prints it. */
  readonly mermaid: string;
  /** Seconds between rewrites, for the refresh and the staleness mark. */
  readonly every: number;
  readonly milestone?: string;
};

const LEGEND: readonly IssueStatus[] = ["workable", "claimed", "in_review", "ready", "merged", "closed", "blocked", "stuck", "skipped", "not_dispatched"];

/** The page. */
export const graphHtml = (json: GraphJson, options: PageOptions): string => {
  const heading = options.milestone === undefined ? json.repo : `${json.repo} \u00b7 ${options.milestone}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${html(PAGE_CSP)}">
<meta http-equiv="refresh" content="${options.every}">
<title>${html(heading)} graph</title>
<style>${STYLE}</style>
</head>
<body data-every="${options.every}">
<header>
<h1>${html(heading)}</h1>
<span id="fetched">fetched ${html(json.fetched_at)}</span>
<span id="stale">stale: not rewritten for over ${3 * options.every} s</span>
</header>
<ul class="legend">
${LEGEND.map((status) => `<li class="${status}">${status.replace("_", " ")}</li>`).join("\n")}
<li class="outside">outside the group</li>
</ul>
<div id="diagram"></div>
<div id="fallback">
<p>Pele did not load, so this is the flowchart's Mermaid text, for ondine.sh or a GitHub comment.</p>
<pre id="source">${html(options.mermaid)}</pre>
</div>
<div id="tooltip" role="tooltip" hidden></div>
<script id="graph" type="application/json">${scriptJson(json)}</script>
<script src="${PELE_URL}" integrity="${PELE_INTEGRITY}" crossorigin="anonymous"></script>
<script>${SCRIPT}</script>
</body>
</html>
`;
};
