import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { graphHtml, PAGE_CSP, PELE_INTEGRITY, PELE_URL, scriptJson } from "../src/graph-html.ts";
import { graphMermaid } from "../src/graph-mermaid.ts";
import { FIXTURE } from "./graph-fixture.ts";

const MERMAID = graphMermaid(FIXTURE);
const PAGE = graphHtml(FIXTURE, { mermaid: MERMAID, every: 60 });
const between = (text: string, open: string, close: string) => {
  const start = text.indexOf(open);
  return start === -1 ? undefined : text.slice(start + open.length, text.indexOf(close, start + open.length));
};
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

test("the embedded JSON escapes <, >, and &, so a </script> title stays inside its string", () => {
  expect(scriptJson({ title: "</script><b>&" })).toBe('{"title":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"}');
  const json = between(PAGE, '<script id="graph" type="application/json">', "</script>") as string;
  expect(json).toContain("\\u003c/script\\u003e");
  expect(json).not.toMatch(/[<>&]/);
  expect(JSON.parse(json)).toEqual(FIXTURE);
  // The page's only </script> tags close its three scripts.
  expect(PAGE.match(/<\/script>/gi)?.length).toBe(3);
});

test("the page loads Pele at the pinned version with its integrity, under a CSP that allows that script and nothing else remote", () => {
  expect(PELE_URL).toBe("https://cdn.jsdelivr.net/npm/pele@1.8.0/dist/pele.global.js");
  expect(PAGE).toContain(`<script src="${PELE_URL}" integrity="${PELE_INTEGRITY}" crossorigin="anonymous"></script>`);
  expect(PELE_INTEGRITY).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  expect(PAGE).toContain(`<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`);
  const directives = new Map(PAGE_CSP.split("; ").map((directive) => [directive.split(" ")[0], directive.split(" ").slice(1)]));
  expect(directives.get("default-src")).toEqual(["'none'"]);
  // The one remote source is Pele's URL; the inline script and style are allowed by their hashes.
  const inline = between(PAGE, "<script>", "</script>") as string;
  const style = between(PAGE, "<style>", "</style>") as string;
  expect(directives.get("script-src")).toEqual([PELE_URL, hash(inline)]);
  expect(directives.get("style-src-elem")).toEqual([hash(style)]);
  expect(PAGE_CSP.match(/https?:\/\/[^\s;]+/g)).toEqual([PELE_URL]);
  // No other element fetches anything: the only src or href attribute in the markup is Pele's.
  expect([...PAGE.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((match) => match[1])).toEqual([PELE_URL]);
  // Tooltips are built with textContent, never innerHTML.
  expect(inline).toContain("textContent = line");
  expect(inline).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

test("the page refreshes at the --every interval, 60 s without it, and marks itself stale after three", () => {
  expect(PAGE).toContain('<meta http-equiv="refresh" content="60">');
  expect(PAGE).toContain('<body data-every="60">');
  const every = graphHtml(FIXTURE, { mermaid: MERMAID, every: 45 });
  expect(every).toContain('<meta http-equiv="refresh" content="45">');
  expect(every).toContain("stale: not rewritten for over 135 s");
  expect(PAGE).toContain(`<span id="fetched">fetched ${FIXTURE.fetched_at}</span>`);
  expect(between(PAGE, "<script>", "</script>")).toContain("age > 3 * every");
});

test("the page carries the Mermaid text as its fallback, HTML-escaped, for when Pele does not load", () => {
  const source = between(PAGE, '<pre id="source">', "</pre>") as string;
  expect(source).not.toMatch(/[<>]/);
  expect(source.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")).toBe(MERMAID);
  expect(PAGE).toContain("Pele did not load, so this is the flowchart's Mermaid text");
  // Shown until the page script draws the flowchart.
  expect(between(PAGE, "<style>", "</style>")).toContain(".drawn #fallback{display:none}");
});

test("the heading names the milestone shown, escaped", () => {
  const page = graphHtml(FIXTURE, { mermaid: graphMermaid(FIXTURE, { milestone: "M0" }), every: 60, milestone: "<M0>" });
  expect(page).toContain("<h1>johnrees/widget \u00b7 &lt;M0&gt;</h1>");
  expect(page).toContain("<title>johnrees/widget \u00b7 &lt;M0&gt; graph</title>");
});
