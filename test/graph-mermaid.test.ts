import { expect, test } from "bun:test";
import { Failure } from "../src/failure.ts";
import { graphMermaid, LIMITS, mermaidLabel, mermaidWarnings, shortTitle } from "../src/graph-mermaid.ts";
import { FIXTURE } from "./graph-fixture.ts";

const GOLDEN = `flowchart LR
classDef blocked fill:#fde2e1,stroke:#c0392b,color:#24292f
classDef stuck fill:#f9d0ec,stroke:#a3166b,color:#24292f
classDef not_dispatched fill:#eeeeee,stroke:#8c959f,color:#24292f
classDef skipped fill:#f5e6c8,stroke:#9a6700,color:#24292f
classDef workable fill:#dcf5e3,stroke:#1a7f37,color:#24292f
classDef claimed fill:#fff1b8,stroke:#bf8700,color:#24292f
classDef in_review fill:#dbe9ff,stroke:#0969da,color:#24292f
classDef ready fill:#cdf3f0,stroke:#0e8a83,color:#24292f
classDef merged fill:#ece2ff,stroke:#8250df,color:#24292f
classDef closed fill:#f6f8fa,stroke:#6e7781,color:#57606a
classDef outside stroke-dasharray:5 4
subgraph m1["M0"]
  i1["#35;1 Say #quot;hi#quot; ] and #lt;/script#gt;#lt;b#gt;x#lt;/b#gt;"]:::workable
  i2["#35;2 end"]:::blocked
  i5["#35;5 Ready one"]:::ready
  i12["#35;12 Done"]:::merged
end
subgraph m2["end"]
  i3["#35;3 #35;12; is not an entity"]:::claimed
end
subgraph m3["Old"]
  i14["#35;14 Old groundwork"]:::merged
end
subgraph m_none["No milestone"]
  i4["#35;4 Ship it \u{1F680} now #amp; #96;then#96;"]:::in_review
  i7["#35;7 A title that runs on well past the forty…"]:::not_dispatched
  i8["#35;8 Held for a person"]:::skipped
  i9["#35;9 One side"]:::stuck
  i10["#35;10 Other side"]:::stuck
  i13["#35;13 Abandoned"]:::closed
end
x_johnrees_other_41["johnrees/other#35;41"]
class x_johnrees_other_41 outside
i14 --> i1
x_johnrees_other_41 --> i1
i1 --> i2
i10 --> i9
i9 --> i10
click i1 "https://github.com/johnrees/widget/issues/1"
click i2 "https://github.com/johnrees/widget/issues/2"
click i3 "https://github.com/johnrees/widget/issues/3"
click i4 "https://github.com/johnrees/widget/issues/4"
click i5 "https://github.com/johnrees/widget/issues/5"
click i7 "https://github.com/johnrees/widget/issues/7"
click i8 "https://github.com/johnrees/widget/issues/8"
click i9 "https://github.com/johnrees/widget/issues/9"
click i10 "https://github.com/johnrees/widget/issues/10"
click i12 "https://github.com/johnrees/widget/issues/12"
click i13 "https://github.com/johnrees/widget/issues/13"
click i14 "https://github.com/johnrees/widget/issues/14"
click x_johnrees_other_41 "https://github.com/johnrees/other/issues/41"
`;

test("the flowchart groups issues by milestone number, the closed blocker's closed milestone included and none last, colours each by status, and draws each blocked_by edge", () => {
  expect(graphMermaid(FIXTURE)).toBe(GOLDEN);
  // Every status has its classDef, spelled as graph --json spells it.
  for (const status of ["blocked", "stuck", "not_dispatched", "skipped", "workable", "claimed", "in_review", "ready", "merged", "closed"]) expect(GOLDEN).toContain(`\nclassDef ${status} `);
  // Pure: the same text twice, and the input untouched.
  const before = JSON.stringify(FIXTURE);
  expect(graphMermaid(FIXTURE)).toBe(GOLDEN);
  expect(JSON.stringify(FIXTURE)).toBe(before);
});

test("labels are quoted with # first, then quotes, angle brackets, ampersands, and backticks as entity codes, so a title stays text", () => {
  expect(mermaidLabel('#12; "a" </script> & `b`')).toBe('"#35;12; #quot;a#quot; #lt;/script#gt; #amp; #96;b#96;"');
  expect(mermaidLabel("two\nlines\t here ")).toBe('"two lines here"');
  // No title can close its label or its line: every quote and newline is gone, and ids come from numbers.
  for (const line of GOLDEN.split("\n").filter((line) => line.includes("["))) expect(line).toMatch(/^(subgraph \w+|\s*\w+)\["[^"\n]*"\](:::\w+)?$/);
});

test("titles are cut at the last word break within 40 characters, with … when cut", () => {
  expect(shortTitle("A title that runs on well past the forty character cut")).toBe("A title that runs on well past the forty…");
  expect(shortTitle("x".repeat(40))).toBe("x".repeat(40));
  expect(shortTitle("x".repeat(50))).toBe(`${"x".repeat(40)}…`);
  expect(shortTitle(`${"\u{1F680}".repeat(39)} more`)).toBe(`${"\u{1F680}".repeat(39)}…`);
});

test("--milestone prints that group alone, its outside blockers as dashed nodes so no edge is lost", () => {
  const text = graphMermaid(FIXTURE, { milestone: "m0" });
  expect(text).toBe(`flowchart LR
classDef blocked fill:#fde2e1,stroke:#c0392b,color:#24292f
classDef workable fill:#dcf5e3,stroke:#1a7f37,color:#24292f
classDef ready fill:#cdf3f0,stroke:#0e8a83,color:#24292f
classDef merged fill:#ece2ff,stroke:#8250df,color:#24292f
classDef outside stroke-dasharray:5 4
subgraph m1["M0"]
  i1["#35;1 Say #quot;hi#quot; ] and #lt;/script#gt;#lt;b#gt;x#lt;/b#gt;"]:::workable
  i2["#35;2 end"]:::blocked
  i5["#35;5 Ready one"]:::ready
  i12["#35;12 Done"]:::merged
end
i14["#35;14 Old groundwork"]:::merged
class i14 outside
x_johnrees_other_41["johnrees/other#35;41"]
class x_johnrees_other_41 outside
i14 --> i1
x_johnrees_other_41 --> i1
i1 --> i2
click i1 "https://github.com/johnrees/widget/issues/1"
click i2 "https://github.com/johnrees/widget/issues/2"
click i5 "https://github.com/johnrees/widget/issues/5"
click i12 "https://github.com/johnrees/widget/issues/12"
click i14 "https://github.com/johnrees/widget/issues/14"
click x_johnrees_other_41 "https://github.com/johnrees/other/issues/41"
`);
  // An issue in the group that blocks one outside it keeps only the edges into the group.
  expect(graphMermaid(FIXTURE, { milestone: "END" })).toContain('subgraph m2["end"]\n  i3["#35;3 #35;12; is not an entity"]:::claimed\nend\n');
  const none = graphMermaid(FIXTURE, { milestone: "None" });
  expect(none).toContain('subgraph m_none["No milestone"]');
  expect(none).not.toContain("subgraph m1");
  expect(none).not.toContain("outside");
});

test("--milestone refuses an unknown title, naming the milestones there are; a closed one needs --all", () => {
  expect(() => graphMermaid(FIXTURE, { milestone: "M9" })).toThrow(Failure);
  expect(() => graphMermaid(FIXTURE, { milestone: "M9" })).toThrow('johnrees/widget has no milestone "M9" (a closed one needs --all); its milestones are "M0", "end", none');
  // #14's milestone is closed, so only --all lists it.
  expect(() => graphMermaid(FIXTURE, { milestone: "Old" })).toThrow("a closed one needs --all");
  const all = { ...FIXTURE, milestones: [...FIXTURE.milestones, { number: 3, title: "Old", description: "", state: "closed" as const, open: 0, closed: 1 }] };
  expect(graphMermaid(all, { milestone: "old" })).toContain('subgraph m3["Old"]\n  i14["#35;14 Old groundwork"]:::merged\nend\n');
  // A milestone with none of its issues in the graph is drawn empty.
  const empty = { ...FIXTURE, milestones: [...FIXTURE.milestones, { number: 4, title: "Later", description: "", state: "open" as const, open: 0, closed: 0 }] };
  expect(graphMermaid(empty, { milestone: "Later" })).toBe('flowchart LR\nsubgraph m4["Later"]\nend\n');
});

test("a blocker in a repository whose name is not a plain owner/repo gets a safe id and label, and no link", () => {
  const odd = { ...FIXTURE, issues: [{ ...(FIXTURE.issues[0] as (typeof FIXTURE.issues)[number]), blocked_by: [{ issue: 5, repo: 'a"b/c d', open: true }] }] };
  const text = graphMermaid(odd);
  expect(text).toContain('x_a_b_c_d_5["a#quot;b/c d#35;5"]\nclass x_a_b_c_d_5 outside\nx_a_b_c_d_5 --> i1\n');
  expect(text).not.toContain("click x_");
});

test("the flowchart warns past Ondine's URL limit and GitHub's maxTextSize and maxEdges, and not under them", () => {
  expect(mermaidWarnings(GOLDEN)).toEqual([]);
  expect(mermaidWarnings(graphMermaid(FIXTURE, { milestone: "M0" }))).toEqual([]);
  const long = `flowchart LR\n${"%% x\n".repeat(LIMITS.url / 2)}`;
  expect(mermaidWarnings(long)).toEqual([expect.stringContaining("over Ondine's 4096; --milestone <title> prints one milestone")]);
  expect(mermaidWarnings(long, true)).toEqual([expect.stringMatching(/over Ondine's 4096$/)]);
  const wide = `flowchart LR\n${Array.from({ length: 501 }, (_, index) => `i${index} --> i${index + 1}`).join("\n")}\n${"x".repeat(LIMITS.text)}`;
  expect(mermaidWarnings(wide)).toEqual([
    expect.stringContaining("URL-encoded, over Ondine's 4096"),
    expect.stringContaining("over GitHub's Mermaid maxTextSize of 50000"),
    "agent-gh: the flowchart has 501 edges, over GitHub's Mermaid maxEdges of 500",
  ]);
});
