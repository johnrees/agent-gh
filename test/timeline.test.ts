import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphJson } from "../src/graph.ts";
import { ago, escape, externalUrl, focus, focusGroups, focusSummary, githubUrl, type Hideable, parseHash, RADIUS, rowText, scriptJson, stateHash, summaryText, type TimelineLayout, timelineHover, timelineHtml, timelineLayout, timelineSvg } from "../src/timeline.ts";

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

test("each edge is its own path, from its source node out to the lane and into its own target, with no arrowhead", () => {
  const layout = timelineLayout(graph());
  const drawn = timelineSvg(layout);
  expect(drawn.edges.map((edge) => [edge.from, edge.to])).toEqual(layout.edges.map((edge) => [edge.from, edge.to]));
  const node = (row: number) => drawn.nodes[row] as { cx: number; cy: number };
  layout.edges.forEach((edge, at) => {
    const d = (drawn.edges[at] as { d: string }).d;
    if (edge.lane === null) expect(d).toBe(`M${node(edge.from).cx} ${node(edge.from).cy + RADIUS}V${node(edge.to).cy - RADIUS}`);
    else if (edge.from !== edge.to) {
      expect(d.startsWith(`M${node(edge.from).cx - RADIUS} ${node(edge.from).cy}H`)).toBe(true);
      expect(d.endsWith(` ${node(edge.to).cy}H${node(edge.to).cx - RADIUS}`)).toBe(true);
    }
  });
  // #3's two targets: two paths leaving the same point, overlapping on its lane.
  const three = drawn.edges.filter((edge) => edge.from === at(layout, "#3"));
  expect(three).toHaveLength(2);
  expect(three[0]?.d.split("V")[0]).toBe(three[1]?.d.split("V")[0]);
});

/** A graph of issues `blocked_by` one another here, each `[number, blockers, status?]`; `merged` and `closed` ones are closed. */
const chain = (...issues: readonly (readonly [number, readonly number[], GraphJson["issues"][number]["status"]?])[]): GraphJson => {
  const json = graph();
  const base = json.issues[0] as GraphJson["issues"][number];
  const closed = new Set(issues.filter(([, , status]) => status === "merged" || status === "closed").map(([issue]) => issue));
  return {
    ...json,
    milestones: [],
    stuck: [],
    cycles: [],
    issues: issues.map(([issue, blockers, status]) => ({
      ...base, issue, milestone: null, state: closed.has(issue) ? "closed" : "open", status: status ?? "blocked",
      blocked_by: blockers.map((number) => ({ issue: number, repo: null, open: !closed.has(number) })),
    })),
  };
};
const focused = (json: GraphJson, key: string, hidden: ReadonlySet<Hideable> = new Set()) => {
  const layout = timelineLayout(json, { hidden });
  const seen = focus(json, layout, at(layout, key));
  return { steps: Object.fromEntries(seen.steps), unlocks: Object.fromEntries(seen.unlocks), waiting: [...seen.waiting].sort(), summary: summaryText(focusSummary(key, seen)) };
};

test("focus: a three-level chain is steps 1, 2, and 3, and unlocks ↓1, ↓2, and ↓3", () => {
  const json = chain([1, []], [2, [1]], [3, [2]], [4, [3]]);
  expect(focused(json, "#4")).toEqual({ steps: { "#1": 1, "#2": 2, "#3": 3 }, unlocks: {}, waiting: [], summary: "#4: 3 steps (●1 ∥ ●1 ∥ ●1) · unlocks 0" });
  expect(focused(json, "#1")).toEqual({ steps: {}, unlocks: { "#2": 1, "#3": 2, "#4": 3 }, waiting: [], summary: "#1: nothing open blocks it · unlocks ●1 ●1 ●1" });
});

test("focus: two independent blockers share step 1", () => {
  expect(focused(chain([1, []], [2, []], [3, [1, 2]]), "#3")).toMatchObject({ steps: { "#1": 1, "#2": 1 }, summary: "#3: 1 step (●2) · unlocks 0" });
});

test("focus: in a diamond a step comes from the longest open chain, not the shortest", () => {
  // #5 waits on #4 and on #2 directly; #4 on #2 and #3; both of those on #1.
  expect(focused(chain([1, []], [2, [1]], [3, [1]], [4, [2, 3]], [5, [4, 2]]), "#5")).toMatchObject({
    steps: { "#1": 1, "#2": 2, "#3": 2, "#4": 3 },
    summary: "#5: 3 steps (●1 ∥ ●2 ∥ ●1) · unlocks 0",
  });
});

test("focus: a closed blocker is done, so the walk stops there; an open blocker elsewhere is a leaf", () => {
  expect(focused(chain([1, []], [2, [1], "merged"], [3, [2]]), "#3")).toMatchObject({ steps: {}, summary: "#3: nothing open blocks it · unlocks 0" });
  expect(focused(chain([1, []], [2, [1], "merged"], [3, [2, 4]], [4, [1]]), "#3").steps).toEqual({ "#1": 1, "#4": 2 });
  expect(focused(graph(), "#11").steps).toEqual({ "johnrees/other#5": 1 });
  // #7's blocker elsewhere is closed, and #3's and #4's blocker #1 is merged.
  expect(focused(graph(), "#7").steps).toEqual({ "#3": 1, "#4": 1 });
});

test("focus: a cycle gives ∞, and a row on both sides of it is a step", () => {
  const json = chain([1, [2]], [2, [1]], [3, [2]]);
  expect(focused(json, "#3")).toMatchObject({ steps: { "#1": "cycle", "#2": "cycle" }, summary: "#3: ●2 ∞ in a cycle · unlocks 0" });
  expect(focused(json, "#1")).toEqual({ steps: { "#2": "cycle" }, unlocks: {}, waiting: ["#3"], summary: "#1: ●1 ∞ in a cycle · unlocks 0" });
  // An issue that blocks itself keeps the cycle warning and its loop, but no badge of its own.
  const self = chain([1, [1]], [2, [1]]);
  expect(focused(self, "#1")).toEqual({ steps: { "#1": "cycle" }, unlocks: { "#2": 1 }, waiting: [], summary: "#1: ●1 ∞ in a cycle · unlocks ●1" });
  const layout = timelineLayout(self);
  const hover = timelineHover(self, layout, at(layout, "#1"));
  expect(hover.edges[layout.edges.findIndex((edge) => edge.from === edge.to)]).toBe("blocker c0");
  expect(hover.badges.has(at(layout, "#1"))).toBe(false);
});

test("focus: a child with a second open blocker waits, even on a hidden one, and is not unlocked", () => {
  expect(focused(chain([1, []], [2, []], [3, [1, 2]], [4, [3]]), "#1")).toMatchObject({ unlocks: {}, waiting: ["#3", "#4"] });
  expect(focused(chain([1, []], [2, [], "skipped"], [3, [1, 2]]), "#1", new Set<Hideable>(["skipped"]))).toMatchObject({ unlocks: {}, waiting: ["#3"] });
  // A closed second blocker no longer blocks.
  expect(focused(chain([1, []], [2, [], "merged"], [3, [1, 2]]), "#1")).toMatchObject({ unlocks: { "#3": 1 }, waiting: [] });
});

test("focus: a grandchild unlocked through ↓1 is at ↓2", () => {
  expect(focused(chain([1, []], [2, [1]], [3, [2]], [4, [1, 2]]), "#1")).toMatchObject({ unlocks: { "#2": 1, "#3": 2, "#4": 2 }, waiting: [], summary: "#1: nothing open blocks it · unlocks ●1 ●2" });
});

test("hovering a row: each level group in its own colour, unlock edges dashed; what waits on more stays grey; the rest fades", () => {
  const hovered = (json: GraphJson, key: string) => {
    const layout = timelineLayout(json);
    const hover = timelineHover(json, layout, at(layout, key));
    const keys = keysOf(layout);
    return {
      edges: layout.edges.map((edge, index) => `${keys[edge.from]}>${keys[edge.to]} ${hover.edges[index]}`.trim()).filter((line) => !line.endsWith("faded")),
      badges: Object.fromEntries([...hover.badges].map(([row, badge]) => [keys[row], `${badge.text} ${badge.tone}`])),
      shown: keys.filter((_, row) => !hover.faded.has(row)),
      summary: hover.summary.map((part) => (typeof part === "string" ? part : `●${part.tone}`)).join(""),
    };
  };
  expect(hovered(graph(), "#7")).toEqual({ edges: ["#3>#7 blocker c0", "#4>#7 blocker c0"], badges: { "#3": "1 c0", "#4": "1 c0" }, shown: ["#3", "#4", "#7"], summary: "#7: 1 step (●c02) · unlocks 0" });
  expect(hovered(graph(), "#3")).toEqual({ edges: ["#3>#8 child c0", "#3>#7"], badges: { "#8": "↓1 c0", "#7": "↓ wait" }, shown: ["#3", "#8", "#7"], summary: "#3: nothing open blocks it · unlocks ●c01" });
  // Groups take the palette in order, step 1 first, then ↓1; an edge takes its source's group (out of the row itself, its target's).
  const long = chain([1, []], [2, [1]], [3, [2]], [4, [3]], [5, [4]], [6, [5]], [7, [6]]);
  expect(hovered(long, "#4")).toMatchObject({
    edges: ["#1>#2 blocker c0", "#2>#3 blocker c1", "#3>#4 blocker c2", "#4>#5 child c3", "#5>#6 child c3", "#6>#7 child c4"],
    summary: "#4: 3 steps (●c01 ∥ ●c11 ∥ ●c21) · unlocks ●c31 ●c41 ●c51",
  });
  // A seventh group cycles back to the first colour.
  const eight = chain([1, []], [2, [1]], [3, [2]], [4, [3]], [5, [4]], [6, [5]], [7, [6]], [8, [7]]);
  expect(hovered(eight, "#8").badges).toEqual({ "#1": "1 c0", "#2": "2 c1", "#3": "3 c2", "#4": "4 c3", "#5": "5 c4", "#6": "6 c5", "#7": "7 c0" });
  expect([...focusGroups(focus(eight, timelineLayout(eight), 0)).values()]).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c0"]);
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

test("the hash keeps the hidden set and the pin; an unknown name is ignored", () => {
  expect(parseHash("#hide=merged,closed")).toEqual({ hidden: new Set(["merged", "closed"]), pin: undefined });
  expect(parseHash("#hide=merged,nonsense,external&pin=42&zoom=2")).toEqual({ hidden: new Set(["merged", "external"]), pin: "#42" });
  expect(parseHash("#pin=johnrees%2Fother%235")).toEqual({ hidden: new Set(), pin: "johnrees/other#5" });
  expect(parseHash("#hide=%E0%A4%A&pin=")).toEqual({ hidden: new Set(), pin: undefined });
  expect(parseHash("")).toEqual({ hidden: new Set(), pin: undefined });
  expect(stateHash({ hidden: new Set<Hideable>(["closed", "merged"]), pin: "#42" })).toBe("#hide=merged,closed&pin=42");
  expect(stateHash({ hidden: new Set(), pin: "johnrees/other#5" })).toBe("#pin=johnrees%2Fother%235");
  expect(stateHash({ hidden: new Set(), pin: undefined })).toBe("");
  for (const state of [{ hidden: new Set<Hideable>(["external", "stuck"]), pin: "#7" }, { hidden: new Set<Hideable>(), pin: "johnrees/other#9" }]) expect(parseHash(stateHash(state))).toEqual(state);
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
