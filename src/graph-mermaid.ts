/**
 * `agent-gh graph --mermaid`: `graph --json` as a Mermaid `flowchart LR`,
 * one `subgraph` per milestone, one node per issue with its status as a
 * class, and an edge per `blocked_by` entry, so Pele, Ondine, or GitHub draws
 * it. Pure. Titles and milestone titles are anyone's text, so every label is
 * quoted with its `#`, `"`, `<`, `>`, `&`, and backtick written as Mermaid's
 * entity codes; ids and links are built from numbers and repository names
 * only.
 */
import { Failure } from "./failure.ts";
import type { GraphJson, IssueStatus } from "./graph.ts";

/** Each status's colours, and the dashed border of a node outside the group shown (or the repository). */
export const STATUS_STYLES: Readonly<Record<IssueStatus, string>> = {
  blocked: "fill:#fde2e1,stroke:#c0392b,color:#24292f",
  stuck: "fill:#f9d0ec,stroke:#a3166b,color:#24292f",
  not_dispatched: "fill:#eeeeee,stroke:#8c959f,color:#24292f",
  skipped: "fill:#f5e6c8,stroke:#9a6700,color:#24292f",
  workable: "fill:#dcf5e3,stroke:#1a7f37,color:#24292f",
  claimed: "fill:#fff1b8,stroke:#bf8700,color:#24292f",
  in_review: "fill:#dbe9ff,stroke:#0969da,color:#24292f",
  ready: "fill:#cdf3f0,stroke:#0e8a83,color:#24292f",
  merged: "fill:#ece2ff,stroke:#8250df,color:#24292f",
  closed: "fill:#f6f8fa,stroke:#6e7781,color:#57606a",
};
export const OUTSIDE_STYLE = "stroke-dasharray:5 4";

/** GitHub's Mermaid limits, and Ondine's for a URL. */
export const LIMITS = { url: 4096, text: 50_000, edges: 500 } as const;

const STAGE = "reading the graph";

/** Text as a quoted Mermaid label: `#` first, so `#12;` and the codes written here stay text. */
export const mermaidLabel = (text: string): string =>
  `"${text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/&/g, "#amp;")
    .replace(/`/g, "#96;")}"`;

/** A title cut at the last word break within 40 characters, with `…` when cut. */
export const shortTitle = (title: string): string => {
  const chars = Array.from(title.replace(/\s+/g, " ").trim());
  if (chars.length <= 40) return chars.join("");
  const cut = chars.slice(0, 41).join("");
  const end = cut.lastIndexOf(" ");
  return `${(end > 0 ? cut.slice(0, end) : chars.slice(0, 40).join("")).trimEnd()}…`;
};

const SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

type Issue = GraphJson["issues"][number];
type Group = { readonly id: string; readonly title: string; readonly number: number };

const NONE: Group = { id: "m_none", title: "No milestone", number: Number.POSITIVE_INFINITY };
const groupOf = (issue: Issue): Group => (issue.milestone === null ? NONE : { id: `m${issue.milestone_number}`, title: issue.milestone, number: issue.milestone_number ?? 0 });

/**
 * The milestone `--milestone` names, matched exactly ignoring case, or `none`
 * for the issues with no milestone; an unknown one is refused, naming those
 * there are.
 */
const chosen = (json: GraphJson, wanted: string): Group => {
  if (wanted.toLowerCase() === "none") return NONE;
  const found = json.milestones.find((milestone) => milestone.title.toLowerCase() === wanted.toLowerCase());
  if (found !== undefined) return { id: `m${found.number}`, title: found.title, number: found.number };
  const names = [...json.milestones.map((milestone) => JSON.stringify(milestone.title)), "none"].join(", ");
  throw new Failure(STAGE, `${json.repo} has no milestone ${JSON.stringify(wanted)} (a closed one needs --all); its milestones are ${names}`);
};

export type MermaidOptions = { readonly milestone?: string };

type Drawn = { readonly line: string; readonly status: IssueStatus | undefined; readonly url: string | undefined; readonly outside: boolean };

/**
 * The flowchart: one group per milestone on an issue in the graph, by
 * milestone number, then the issues with none. With `milestone`, only that
 * group (drawn even when empty), plus each of its blockers outside it as a
 * dashed node, so no edge is lost.
 */
export const graphMermaid = (json: GraphJson, options: MermaidOptions = {}): string => {
  const only = options.milestone === undefined ? undefined : chosen(json, options.milestone);
  const byNumber = new Map(json.issues.map((issue) => [issue.issue, issue]));
  const shown = only === undefined ? json.issues : json.issues.filter((issue) => groupOf(issue).id === only.id);
  const groups = new Map<string, Group>(only === undefined ? [] : [[only.id, only]]);
  for (const issue of shown) groups.set(groupOf(issue).id, groupOf(issue));
  const drawn = new Map<string, Drawn>();
  const link = (number: number) => `https://github.com/${json.repo}/issues/${number}`;
  const issueNode = (issue: Issue, outside: boolean): Drawn => ({
    line: `i${issue.issue}[${mermaidLabel(`#${issue.issue} ${shortTitle(issue.title)}`)}]:::${issue.status}`, status: issue.status, url: link(issue.issue), outside,
  });
  for (const issue of shown) drawn.set(`i${issue.issue}`, issueNode(issue, false));
  const edges: string[] = [];
  for (const issue of shown) {
    for (const blocker of issue.blocked_by) {
      const id = blocker.repo === null ? `i${blocker.issue}` : `x_${blocker.repo.replace(/[^A-Za-z0-9]/g, "_")}_${blocker.issue}`;
      if (!drawn.has(id)) {
        const found = blocker.repo === null ? byNumber.get(blocker.issue) : undefined;
        if (found !== undefined) drawn.set(id, issueNode(found, true));
        else {
          const label = blocker.repo === null ? `#${blocker.issue}` : `${blocker.repo}#${blocker.issue}`;
          const url = blocker.repo === null ? link(blocker.issue) : SLUG.test(blocker.repo) ? `https://github.com/${blocker.repo}/issues/${blocker.issue}` : undefined;
          drawn.set(id, { line: `${id}[${mermaidLabel(label)}]`, status: undefined, url, outside: true });
        }
      }
      edges.push(`${id} --> i${issue.issue}`);
    }
  }
  const lines = ["flowchart LR"];
  const statuses = new Set([...drawn.values()].map((node) => node.status));
  for (const [status, style] of Object.entries(STATUS_STYLES)) if (statuses.has(status as IssueStatus)) lines.push(`classDef ${status} ${style}`);
  const outside = [...drawn].filter(([, node]) => node.outside);
  if (outside.length > 0) lines.push(`classDef outside ${OUTSIDE_STYLE}`);
  for (const group of [...groups.values()].sort((a, b) => a.number - b.number)) {
    lines.push(`subgraph ${group.id}[${mermaidLabel(group.title)}]`);
    for (const issue of shown) if (groupOf(issue).id === group.id) lines.push(`  ${(drawn.get(`i${issue.issue}`) as Drawn).line}`);
    lines.push("end");
  }
  for (const [id, node] of outside) lines.push(node.line, `class ${id} outside`);
  lines.push(...edges);
  for (const [id, node] of drawn) if (node.url !== undefined) lines.push(`click ${id} "${node.url}"`);
  return `${lines.join("\n")}\n`;
};

/** The stderr warnings for a flowchart past Ondine's URL limit or GitHub's `maxTextSize` or `maxEdges`. */
export const mermaidWarnings = (text: string, oneMilestone = false): string[] => {
  const warnings: string[] = [];
  const encoded = encodeURIComponent(text).length;
  if (encoded > LIMITS.url) warnings.push(`agent-gh: the flowchart is ${encoded} characters URL-encoded, over Ondine's ${LIMITS.url}${oneMilestone ? "" : "; --milestone <title> prints one milestone"}`);
  if (text.length > LIMITS.text) warnings.push(`agent-gh: the flowchart is ${text.length} characters, over GitHub's Mermaid maxTextSize of ${LIMITS.text}`);
  const edges = text.match(/^\w+ --> \w+$/gm)?.length ?? 0;
  if (edges > LIMITS.edges) warnings.push(`agent-gh: the flowchart has ${edges} edges, over GitHub's Mermaid maxEdges of ${LIMITS.edges}`);
  return warnings;
};
