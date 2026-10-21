import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphJson } from "../src/graph.ts";
import { ago, escape, timelineHtml, timelineLayout } from "../src/timeline.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "timeline-graph.json");
const graph = (): GraphJson => JSON.parse(readFileSync(FIXTURE, "utf8")) as GraphJson;

test("every row of the graph and each blocker in another repository, every blocker above what it blocks", () => {
  const layout = timelineLayout(graph());
  const keys = layout.rows.map((row) => row.key);
  expect(keys).toEqual(["#1", "#2", "#3", "#4", "#5", "#14", "#6", "#8", "#10", "johnrees/other#5", "#11", "#9", "johnrees/other#9", "#7", "#12", "#13"]);
  const cycle = new Set([keys.indexOf("#12"), keys.indexOf("#13")]);
  for (const edge of layout.edges) if (!cycle.has(edge.to)) expect(edge.from).toBeLessThan(edge.to);
});

test("free rows go by milestone (none last), then priority (none last), then number", () => {
  const json = graph();
  const free = (number: number, milestone: string | null, priority: string | null) => ({ ...(json.issues[0] as GraphJson["issues"][number]), issue: number, milestone, priority, blocked_by: [] });
  const keys = timelineLayout({ ...json, issues: [free(1, null, null), free(2, "M2 <b>bold</b>", null), free(3, "M2 <b>bold</b>", "priority:low"), free(4, "M1", null), free(5, null, "priority:high")], cycles: [] }).rows.map((row) => row.key);
  expect(keys).toEqual(["#4", "#3", "#2", "#5", "#1"]);
});

test("a blocker in another repository gets its own row, labelled and linked, with a dashed ring and no metadata", () => {
  const json = graph();
  const layout = timelineLayout(json);
  const row = layout.rows.find((entry) => entry.key === "johnrees/other#5");
  expect(row).toMatchObject({ repo: "johnrees/other", number: 5, issue: undefined, open: true });
  const at = layout.rows.indexOf(row as (typeof layout.rows)[number]);
  expect(layout.edges).toContainEqual({ from: at, to: at + 1, open: true, lane: null });
  const html = timelineHtml(json);
  expect(html).toContain('<a href="https://github.com/johnrees/other/issues/5">johnrees/other#5</a>');
  expect(html).toContain(`class="node foreign" data-row="${at}"`);
  expect(html).toContain(`class="node foreign shut" data-row="${layout.rows.findIndex((entry) => entry.key === "johnrees/other#9")}"`);
});

test("a single edge to the next row runs down the spine", () => {
  const layout = timelineLayout(graph());
  const [five, fourteen] = [layout.rows.findIndex((row) => row.key === "#5"), layout.rows.findIndex((row) => row.key === "#14")];
  expect(fourteen).toBe(five + 1);
  expect(layout.edges).toContainEqual({ from: five, to: fourteen, open: true, lane: null });
  expect(layout.spans.some((span) => span.source === five)).toBe(false);
});

test("a source with several targets uses one lane, spanning to its last target", () => {
  const layout = timelineLayout(graph());
  const three = layout.rows.findIndex((row) => row.key === "#3");
  const targets = ["#7", "#8"].map((key) => layout.rows.findIndex((row) => row.key === key)).sort((a, b) => a - b);
  expect(layout.spans.filter((span) => span.source === three)).toEqual([{ lane: 2, source: three, targets, from: three, to: targets[1] as number }]);
  expect(new Set(layout.edges.filter((edge) => edge.from === three).map((edge) => edge.lane))).toEqual(new Set([2]));
  // #1's two targets: #3 is the next row, but #4 is not, so both take the lane.
  expect(layout.spans.find((span) => span.source === 0)).toEqual({ lane: 0, source: 0, targets: [2, 3], from: 0, to: 3 });
});

test("the lanes number the most source spans that cross one row, and no two spans on a lane meet", () => {
  const layout = timelineLayout(graph());
  const most = Math.max(...layout.rows.map((_, row) => layout.spans.filter((span) => span.from <= row && row <= span.to).length));
  expect(most).toBe(4);
  expect(layout.lanes).toBe(most);
  for (const a of layout.spans) for (const b of layout.spans) if (a !== b && a.lane === b.lane) expect(a.to < b.from || b.to < a.from).toBe(true);
  expect(timelineHtml(graph())).toContain(`· ${most} lanes`);
});

test("cycle members come last by number, and the edge between them points upward", () => {
  const layout = timelineLayout(graph());
  const n = layout.rows.length;
  expect(layout.rows.slice(-2).map((row) => row.key)).toEqual(["#12", "#13"]);
  expect(layout.edges).toContainEqual({ from: n - 1, to: n - 2, open: true, lane: 0 });
  expect(layout.edges).toContainEqual({ from: n - 2, to: n - 1, open: true, lane: null });
  // What waits on a cycle member, and what waits on that (#6 on #2), comes last with it.
  const json = graph();
  const behind = { ...(json.issues[0] as GraphJson["issues"][number]), issue: 2, state: "open", blocked_by: [{ issue: 12, repo: null, open: true }] };
  const keys = timelineLayout({ ...json, issues: json.issues.map((issue) => (issue.issue === 2 ? behind : issue)) as GraphJson["issues"] }).rows.map((row) => row.key);
  expect(keys.slice(-4)).toEqual(["#2", "#6", "#12", "#13"]);
});

test("hostile titles, labels, and milestones appear escaped, and no JSON is embedded", () => {
  const html = timelineHtml(graph());
  expect(html).toContain("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).toContain("Quote &quot; and &#39; and &amp; here");
  expect(html).toContain("M2 &lt;b&gt;bold&lt;/b&gt;");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(html.match(/<\/script>/g)?.length).toBe(1);
  expect(html).not.toContain('"blocked_by"');
  expect(escape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
});

test("a URL that is not GitHub's is shown plain", () => {
  const json = graph();
  const issues = json.issues.map((issue) =>
    issue.issue === 3 ? { ...issue, url: "javascript:alert(1)", pr: { ...(issue.pr as NonNullable<typeof issue.pr>), url: "https://github.com.evil.example/x/pull/30" } } : issue,
  );
  const html = timelineHtml({ ...json, issues });
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("evil.example");
  expect(html).toContain('<td class="num">#3</td>');
  expect(html).toContain("<td>#30 · review success · checks passed</td>");
  expect(html).toContain('<a href="https://github.com/johnrees/widget/issues/4">#4</a>');
});

test("the columns: status, milestone, holder, claimed, quiet, and pull request, with — for nothing", () => {
  const html = timelineHtml(graph());
  const row = (key: string) => html.split("\n").find((line) => line.includes(`data-key="${key}"`)) as string;
  expect(row("#3")).toContain('<span class="dot s-ready"></span>ready</td><td>M1</td><td>claude</td><td>1d</td><td>5m</td><td><a href="https://github.com/johnrees/widget/pull/30">#30</a> · review success · checks passed</td>');
  expect(row("#5")).toContain("claimed</td><td>M1</td><td>johnrees</td><td>20m</td><td>20m</td><td>—</td>");
  expect(row("#4")).toContain("<td>deepseek</td><td>2d</td><td>4h</td>");
  expect(row("#1")).toContain("merged</td><td>M1</td><td>—</td><td>—</td><td>—</td><td>");
  expect(row("johnrees/other#5")).toContain("<td>—</td>".repeat(6));
  expect(html).toContain("stuck: #11, #12, #13 · cycles: #12, #13");
  for (const status of ["blocked", "stuck", "not_dispatched", "skipped", "workable", "claimed", "in_review", "ready", "merged", "closed"]) expect(html).toContain(`.s-${status} { fill: #`);
  expect(ago("2026-10-21T11:59:30Z", "2026-10-21T12:00:00Z")).toBe("0m");
  expect(ago(null, "2026-10-21T12:00:00Z")).toBe("—");
});

test("the script reads a file or stdin and prints the page", () => {
  const script = join(import.meta.dir, "..", "scripts", "timeline.ts");
  const fromFile = Bun.spawnSync([process.execPath, script, FIXTURE]);
  expect(fromFile.exitCode).toBe(0);
  expect(fromFile.stdout.toString()).toBe(timelineHtml(graph()));
  const fromStdin = Bun.spawnSync([process.execPath, script], { stdin: Buffer.from(readFileSync(FIXTURE)) });
  expect(fromStdin.stdout.toString()).toBe(timelineHtml(graph()));
  const wrong = Bun.spawnSync([process.execPath, script], { stdin: Buffer.from("{}") });
  expect(wrong.exitCode).toBe(1);
});
