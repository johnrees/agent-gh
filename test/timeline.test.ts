import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphJson } from "../src/graph.ts";
import { ago, escape, externalUrl, githubUrl, type Hideable, hideHash, parseHide, rowText, scriptJson, type TimelineLayout, timelineHtml, timelineLayout, timelineSvg } from "../src/timeline.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "timeline-graph.json");
const SCRIPT = join(import.meta.dir, "..", "scripts", "timeline.ts");
const graph = (): GraphJson => JSON.parse(readFileSync(FIXTURE, "utf8")) as GraphJson;
const keysOf = (layout: TimelineLayout) => layout.rows.map((row) => row.key);
const at = (layout: TimelineLayout, key: string) => layout.rows.findIndex((row) => row.key === key);
const mostCrossing = (layout: TimelineLayout) => Math.max(0, ...layout.rows.map((_, row) => layout.spans.filter((span) => span.from <= row && row <= span.to).length));

test("every row of the graph and each blocker in another repository, every blocker above what it blocks", () => {
  const layout = timelineLayout(graph());
  expect(keysOf(layout)).toEqual(["#1", "#2", "#3", "#4", "#5", "#14", "#6", "#8", "#10", "johnrees/other#5", "#11", "#9", "johnrees/other#9", "#7", "#12", "#13"]);
  const cycle = new Set([at(layout, "#12"), at(layout, "#13")]);
  for (const edge of layout.edges) if (!cycle.has(edge.to)) expect(edge.from).toBeLessThan(edge.to);
});

test("free rows go by milestone (none last), then priority (none last), then number", () => {
  const json = graph();
  const free = (number: number, milestone: string | null, priority: string | null) => ({ ...(json.issues[0] as GraphJson["issues"][number]), issue: number, milestone, priority, blocked_by: [] });
  const layout = timelineLayout({ ...json, issues: [free(1, null, null), free(2, "M2 <b>bold</b>", null), free(3, "M2 <b>bold</b>", "priority:low"), free(4, "M1", null), free(5, null, "priority:high")], cycles: [] });
  expect(keysOf(layout)).toEqual(["#4", "#3", "#2", "#5", "#1"]);
});

test("a blocker in another repository gets its own row, with no issue, linked to its issue page", () => {
  const layout = timelineLayout(graph());
  const row = at(layout, "johnrees/other#5");
  expect(layout.rows[row]).toMatchObject({ repo: "johnrees/other", number: 5, issue: undefined, open: true });
  expect(layout.edges).toContainEqual({ from: row, to: row + 1, open: true, lane: null });
  expect(layout.rows[at(layout, "johnrees/other#9")]?.open).toBe(false);
  expect(externalUrl("johnrees/other", 5)).toBe("https://github.com/johnrees/other/issues/5");
  expect(externalUrl("johnrees/other/../x", 5)).toBeNull();
});

test("a single edge to the next row runs down the spine", () => {
  const layout = timelineLayout(graph());
  const [five, fourteen] = [at(layout, "#5"), at(layout, "#14")];
  expect(fourteen).toBe(five + 1);
  expect(layout.edges).toContainEqual({ from: five, to: fourteen, open: true, lane: null });
  expect(layout.spans.some((span) => span.source === five)).toBe(false);
  expect(timelineSvg(layout).edges.find((edge) => edge.from === five)?.d).toMatch(/^M(\S+) \S+V\S+$/);
});

test("a source with several targets uses one lane, spanning to its last target", () => {
  const layout = timelineLayout(graph());
  const three = at(layout, "#3");
  const targets = [at(layout, "#7"), at(layout, "#8")].sort((a, b) => a - b);
  expect(layout.spans.filter((span) => span.source === three)).toEqual([{ lane: 2, source: three, targets, from: three, to: targets[1] as number }]);
  expect(new Set(layout.edges.filter((edge) => edge.from === three).map((edge) => edge.lane))).toEqual(new Set([2]));
  // #1's two targets: #3 is the next row, but #4 is not, so both take the lane.
  expect(layout.spans.find((span) => span.source === 0)).toEqual({ lane: 0, source: 0, targets: [2, 3], from: 0, to: 3 });
});

test("the lanes number the most source spans that cross one row, and no two spans on a lane meet", () => {
  const layout = timelineLayout(graph());
  expect(mostCrossing(layout)).toBe(4);
  expect(layout.lanes).toBe(4);
  for (const a of layout.spans) for (const b of layout.spans) if (a !== b && a.lane === b.lane) expect(a.to < b.from || b.to < a.from).toBe(true);
});

test("cycle members come last by number, and the edge between them points upward", () => {
  const layout = timelineLayout(graph());
  const n = layout.rows.length;
  expect(keysOf(layout).slice(-2)).toEqual(["#12", "#13"]);
  expect(layout.edges).toContainEqual({ from: n - 1, to: n - 2, open: true, lane: 0 });
  expect(layout.edges).toContainEqual({ from: n - 2, to: n - 1, open: true, lane: null });
  // What waits on a cycle member, and what waits on that (#6 on #2), comes last with it.
  const json = graph();
  const behind = { ...(json.issues[0] as GraphJson["issues"][number]), issue: 2, state: "open", blocked_by: [{ issue: 12, repo: null, open: true }] };
  const keys = keysOf(timelineLayout({ ...json, issues: json.issues.map((issue) => (issue.issue === 2 ? behind : issue)) as GraphJson["issues"] }));
  expect(keys.slice(-4)).toEqual(["#2", "#6", "#12", "#13"]);
});

test("hidden statuses drop their rows and every edge to or from them, and the lanes close up", () => {
  const layout = timelineLayout(graph(), { hidden: new Set<Hideable>(["merged", "closed"]) });
  expect(keysOf(layout)).toEqual(["#3", "#4", "#5", "#14", "#6", "#8", "#10", "johnrees/other#5", "#11", "#9", "johnrees/other#9", "#7", "#12", "#13"]);
  // #1's and #2's lanes are gone: #3's and #4's remain, and the upward cycle edge reuses lane 0.
  expect(layout.spans.map((span) => [keysOf(layout)[span.source], span.lane])).toEqual([["#3", 0], ["#4", 1], ["#13", 0]]);
  expect(layout.lanes).toBe(2);
  expect(layout.lanes).toBe(mostCrossing(layout));
  for (const edge of layout.edges) for (const end of [edge.from, edge.to]) expect(end).toBeLessThan(layout.rows.length);
  // Eleven edges less #1's two and #2's one.
  expect(timelineLayout(graph()).edges).toHaveLength(11);
  expect(layout.edges).toHaveLength(8);
});

test("a hidden blocker leaves no lane behind", () => {
  const layout = timelineLayout(graph(), { hidden: new Set<Hideable>(["ready"]) });
  expect(at(layout, "#3")).toBe(-1);
  expect(layout.edges.some((edge) => edge.to === at(layout, "#8"))).toBe(false);
  // #1 now blocks only #4, which does not follow it, so it keeps a lane; #3's spans to #7 and #8 are gone.
  expect(layout.spans.map((span) => [keysOf(layout)[span.source], span.targets.map((target) => keysOf(layout)[target])])).toEqual([
    ["#1", ["#4"]],
    ["#2", ["#6"]],
    ["#4", ["#7"]],
    ["#13", ["#12"]],
  ]);
  expect(layout.lanes).toBe(mostCrossing(layout));
  for (const span of layout.spans) for (const row of [span.source, ...span.targets]) expect(layout.rows[row]).toBeDefined();
});

test("hiding other repos drops their rows; a row elsewhere shows only while a shown issue lists it", () => {
  const external = timelineLayout(graph(), { hidden: new Set<Hideable>(["external"]) });
  expect(keysOf(external).some((key) => key.includes("/"))).toBe(false);
  expect(external.edges.some((edge) => edge.to === at(external, "#11"))).toBe(false);
  const stuck = timelineLayout(graph(), { hidden: new Set<Hideable>(["stuck"]) });
  expect(keysOf(stuck)).not.toContain("johnrees/other#5");
  expect(keysOf(stuck)).toContain("johnrees/other#9");
  expect(timelineLayout(graph(), { hidden: new Set(["merged", "closed", "ready", "in_review", "claimed", "workable", "blocked", "stuck", "skipped", "not_dispatched", "external"]) })).toEqual({ rows: [], edges: [], lanes: 0, spans: [] });
});

test("the hash keeps the hidden set; an unknown name is ignored", () => {
  expect(parseHide("#hide=merged,closed")).toEqual(new Set(["merged", "closed"]));
  expect(parseHide("#hide=merged,nonsense,external")).toEqual(new Set(["merged", "external"]));
  expect(parseHide("#hide=%E0%A4%A")).toEqual(new Set());
  expect(parseHide("")).toEqual(new Set());
  expect(hideHash(new Set<Hideable>(["closed", "merged"]))).toBe("#hide=merged,closed");
  expect(hideHash(new Set())).toBe("");
});

test("the page embeds the graph as escaped JSON: a </script> title stays inside its string", () => {
  const json = graph();
  json.issues[0] = { ...(json.issues[0] as GraphJson["issues"][number]), title: `line${String.fromCharCode(0x2028)}break${String.fromCharCode(0x2029)}` };
  const html = timelineHtml(json, "/* bundle */");
  expect(html).toContain('"title":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"');
  expect(html).toContain('"title":"\\u003cimg src=x onerror=alert(1)\\u003e"');
  expect(html).toContain('"title":"Quote \\" and \' and \\u0026 here"');
  expect(html).toContain('"title":"line\\u2028break\\u2029"');
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(html).not.toContain(String.fromCharCode(0x2028));
  expect(html.match(/<\/script>/g)).toHaveLength(2);
  const embedded = /<script type="application\/json" id="graph">(.*?)<\/script>/s.exec(html)?.[1] as string;
  expect(JSON.parse(embedded)).toEqual(json);
  expect(embedded).toBe(scriptJson(json));
  expect(html).toContain('<script type="module">/* bundle */</script>');
  expect(() => timelineHtml(json, 'x = "</script>"')).toThrow("</script");
  expect(timelineHtml({ ...json, repo: "<b>x</b>" }, "")).toContain("<title>&lt;b&gt;x&lt;/b&gt; timeline</title>");
  expect(escape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
});

test("only a GitHub URL is linked, and the page script never parses HTML", () => {
  expect(githubUrl("https://github.com/johnrees/widget/issues/3")).toBe("https://github.com/johnrees/widget/issues/3");
  for (const url of ["javascript:alert(1)", "https://github.com.evil.example/x", "http://github.com/x", "", null, undefined]) expect(githubUrl(url)).toBeNull();
  const page = readFileSync(join(import.meta.dir, "..", "src", "timeline-page.ts"), "utf8");
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser"]) expect(page).not.toContain(sink);
  expect(page).toContain("githubUrl(url)");
});

test("the columns: milestone, holder, claimed, quiet, and pull request, with — for nothing", () => {
  const json = graph();
  const text = (number: number) => rowText(json.issues.find((issue) => issue.issue === number) as GraphJson["issues"][number], json.fetched_at);
  expect(text(3)).toEqual({ milestone: "M1", holder: "claude", claimed: "1d", quiet: "5m", pull: "review success · checks passed" });
  expect(text(4)).toEqual({ milestone: "M1", holder: "deepseek", claimed: "2d", quiet: "4h", pull: "review pending · checks pending" });
  expect(text(5)).toEqual({ milestone: "M1", holder: "johnrees", claimed: "20m", quiet: "20m", pull: "—" });
  expect(text(1)).toEqual({ milestone: "M1", holder: "—", claimed: "—", quiet: "—", pull: "merged" });
  expect(text(9)).toEqual({ milestone: "—", holder: "—", claimed: "—", quiet: "—", pull: "—" });
  expect(ago("2026-10-21T11:59:30Z", "2026-10-21T12:00:00Z")).toBe("0m");
  expect(ago(null, "2026-10-21T12:00:00Z")).toBe("—");
});

test("the script reads a file or stdin and prints the page with its script bundled in", () => {
  const fromFile = Bun.spawnSync([process.execPath, SCRIPT, FIXTURE]);
  expect(fromFile.exitCode).toBe(0);
  const html = fromFile.stdout.toString();
  const bundle = /<script type="module">(.*?)<\/script>/s.exec(html)?.[1] as string;
  expect(bundle).toContain("http://www.w3.org/2000/svg");
  expect(bundle).toContain("hide=");
  expect(bundle).not.toMatch(/^import |\bimport\(|require\(/m);
  expect(html).toBe(timelineHtml(graph(), bundle));
  const fromStdin = Bun.spawnSync([process.execPath, SCRIPT], { stdin: Buffer.from(readFileSync(FIXTURE)) });
  expect(fromStdin.stdout.toString()).toBe(html);
  expect(Bun.spawnSync([process.execPath, SCRIPT], { stdin: Buffer.from("{}") }).exitCode).toBe(1);
});
