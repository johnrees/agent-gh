import { parseRepo, type Repo } from "./repo.ts";
import { apiCall } from "./review.ts";

/** A known GitHub read and its actual repository, rather than an unrelated cwd. */
export type PublicRead = { readonly repo: Repo | undefined };

type Flags = { readonly values: readonly string[]; readonly booleans: readonly string[] };
type Parsed = { readonly words: readonly string[]; readonly values: readonly [string, string][] };
const REPO: Flags = { values: ["repo", "R"], booleans: [] };
const FORMAT = ["json", "jq", "q", "template", "t"];
const BOOL = /^(?:1|0|t|f|T|F|true|false|TRUE|FALSE|True|False)$/;

/** Deliberately narrower than gh's evolving CLI: a new/unknown flag is not a read grant. */
const parse = (args: readonly string[], flags: Flags): Parsed | undefined => {
  const words: string[] = [];
  const values: [string, string][] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") { words.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith("-") || arg === "-") { words.push(arg); continue; }
    if (arg.startsWith("--")) {
      const at = arg.indexOf("=");
      const name = arg.slice(2, at < 0 ? undefined : at);
      const attached = at < 0 ? undefined : arg.slice(at + 1);
      if (flags.values.includes(name)) {
        const value = attached ?? args[++i];
        if (value === undefined || value === "") return undefined;
        values.push([name, value]);
      } else if (!flags.booleans.includes(name) || (attached !== undefined && !BOOL.test(attached))) return undefined;
    } else {
      for (let j = 1; j < arg.length; j++) {
        const name = arg[j] as string;
        if (flags.values.includes(name)) {
          const value = j + 1 < arg.length ? arg.slice(j + 1).replace(/^=/, "") : args[++i];
          if (value === undefined || value === "") return undefined;
          values.push([name, value]);
          break;
        }
        if (!flags.booleans.includes(name)) return undefined;
        if (arg[j + 1] === "=") {
          if (!BOOL.test(arg.slice(j + 2))) return undefined;
          break;
        }
      }
    }
  }
  return { words, values };
};

const last = (parsed: Parsed, ...names: string[]): string | undefined => parsed.values.findLast(([name]) => names.includes(name))?.[1];

/** No credentials, enterprise host, encoded path, dot segment, or partial repository. */
const repository = (value: string): Repo | undefined => {
  const plain = value.replace(/^https:\/\/github\.com\//i, "").replace(/^github\.com\//, "").replace(/\/$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plain)) return undefined;
  const result = parseRepo(plain);
  return result && ![result.owner, result.name].some((part) => part === "." || part === "..") ? result : undefined;
};

/** Consume only repository flags before a command/verb; no guessed global flag arity. */
const prefix = (args: readonly string[]): { rest: readonly string[]; flags: readonly string[] } | undefined => {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const arg = args[i] as string;
    if (arg === "-R" || arg === "--repo") {
      if (args[i + 1] === undefined || !repository(args[i + 1] as string)) return undefined;
      i += 2;
    } else if (arg.startsWith("--repo=") || arg.startsWith("-R")) {
      const value = arg.startsWith("--repo=") ? arg.slice(7) : arg.slice(2).replace(/^=/, "");
      if (!repository(value)) return undefined;
      i++;
    } else return undefined;
  }
  return { rest: args.slice(i), flags: args.slice(0, i) };
};

const reads: Readonly<Record<string, Flags>> = {
  "pr view": { values: [], booleans: ["comments", "c"] },
  "pr list": { values: ["assignee", "a", "author", "A", "base", "B", "head", "H", "label", "l", "limit", "L", "search", "S", "state", "s", "app"], booleans: ["draft", "d"] },
  "pr diff": { values: ["color"], booleans: ["patch", "name-only"] },
  "pr checks": { values: ["interval", "i"], booleans: ["watch", "required", "fail-fast"] },
  "pr status": { values: [], booleans: ["conflict-status", "c"] },
  "issue view": { values: [], booleans: ["comments", "c"] },
  "issue list": { values: ["assignee", "a", "author", "A", "label", "l", "limit", "L", "mention", "mentions", "milestone", "m", "search", "S", "state", "s", "app"], booleans: [] },
  "issue status": { values: [], booleans: [] },
  "repo view": { values: ["branch", "b"], booleans: [] },
  "repo list": { values: ["language", "l", "limit", "L", "source", "visibility", "topic"], booleans: ["archived", "no-archived", "fork"] },
  "release view": { values: [], booleans: [] },
  "release list": { values: ["limit", "L", "order", "O"], booleans: ["exclude-drafts", "exclude-pre-releases"] },
  "release download": { values: ["archive", "A", "dir", "D", "pattern", "p", "output", "O"], booleans: ["clobber", "skip-existing"] },
};
const SEARCH: Flags = {
  values: ["archived", "assignee", "author", "base", "closed", "commenter", "comments", "committer", "committer-date", "committer-email", "committer-name", "created", "extension", "filename", "head", "involves", "label", "language", "license", "limit", "L", "match", "mentions", "merged", "milestone", "number", "order", "owner", "parent", "project", "reactions", "repo", "R", "review", "review-requested", "reviewed-by", "size", "sort", "stars", "state", "team-mentions", "topic", "updated", "visibility"],
  booleans: ["draft", "include-forks", "is-locked", "is-merged", "is-open", "is-closed", "no-assignee", "no-label", "no-milestone", "no-project"],
};
const API: Flags = {
  values: ["method", "X", "header", "H", "raw-field", "f", "field", "F", "input", "jq", "q", "template", "t", "cache", "hostname", "preview", "p"],
  booleans: ["paginate", "slurp", "include", "i", "silent", "verbose"],
};

const apiRead = (args: readonly string[], fallbackRepo: Repo | undefined): PublicRead | undefined => {
  const parsed = parse(args.slice(1), API);
  if (!parsed || parsed.words.length !== 1) return undefined;
  if (parsed.values.some(([name, value]) => name === "hostname" && value.toLowerCase() !== "github.com")) return undefined;
  // A custom Host/method-override/auth header must never redirect this read grant.
  if (parsed.values.some(([name, value]) => ["header", "H"].includes(name) && !/^(?:accept|x-github-api-version|content-type):/i.test(value))) return undefined;
  const call = apiCall(args);
  if (!call || call.method !== "GET" || call.endpoint !== parsed.words[0] || call.endpoint === undefined || call.input !== undefined) return undefined;
  const endpoint = call.endpoint.replace(/^https:\/\/api\.github\.com\//i, "");
  if (/[:\\]/.test(endpoint.split(/[?#]/)[0] as string) || endpoint.startsWith("//")) return undefined;
  const path = (endpoint.split(/[?#]/)[0] as string).replace(/^\//, "").replace(/\/$/, "");
  const parts = path.split("/");
  if (parts.some((part) => part === "." || part === ".." || part === "" || part.includes("%"))) return undefined;
  if (parts[0]?.toLowerCase() === "graphql") return undefined;
  const current = fallbackRepo;
  if (parts[0]?.toLowerCase() === "repos") {
    if (parts[1] === "{owner}" && parts[2] === "{repo}") return current ? { repo: current } : undefined;
    const target = repository(`${parts[1] ?? ""}/${parts[2] ?? ""}`);
    return target ? { repo: target } : undefined;
  }
  // Numeric repository IDs or unresolved placeholders do not identify a repository to probe.
  if (parts[0]?.toLowerCase() === "repositories" || /[{}]/.test(path)) return undefined;
  return { repo: undefined };
};

/**
 * Only these known reads may use the no-installation public-read path. Undefined
 * means write, unknown, malformed, or ambiguous: the normal App gate still applies.
 * Public/private visibility is deliberately an I/O decision outside this parser.
 */
export const publicRead = (args: readonly string[], fallbackRepo: Repo | undefined): PublicRead | undefined => {
  const first = prefix(args);
  if (!first) return undefined;
  const command = first.rest[0];
  if (command === "api") return apiRead(["api", ...first.flags, ...first.rest.slice(1)], fallbackRepo);
  if (command === undefined) return undefined;
  const second = prefix(first.rest.slice(1));
  if (!second) return undefined;
  const verb = second.rest[0];
  const search = command === "search" && ["code", "issues", "prs", "repos", "commits"].includes(verb ?? "");
  const flags = search ? SEARCH : reads[`${command} ${verb}`];
  if (!flags) return undefined;
  const parsed = parse([...first.flags, ...second.flags, ...second.rest.slice(1)], {
    values: [...REPO.values, ...FORMAT, ...flags.values], booleans: flags.booleans,
  });
  if (!parsed) return undefined;
  const explicit = last(parsed, "repo", "R");
  const current = explicit === undefined ? fallbackRepo : repository(explicit);
  if (explicit !== undefined && current === undefined) return undefined;
  if (search) {
    // Multiple repo filters are not a single public target we can confirm.
    if (parsed.values.filter(([name]) => ["repo", "R"].includes(name)).length > 1) return undefined;
    return { repo: explicit === undefined ? undefined : current };
  }
  if (parsed.words.length > 1) return undefined;
  const target = parsed.words[0];
  if (command === "repo" && verb === "list") return target === undefined || /^[A-Za-z0-9-]+$/.test(target) ? { repo: undefined } : undefined;
  if (command === "repo" && verb === "view") {
    const actual = target === undefined ? current : repository(target);
    return actual ? { repo: actual } : undefined;
  }
  if (["list", "status"].includes(verb ?? "") && target !== undefined) return undefined;
  if (target !== undefined && /[:/\\]/.test(target)) {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/([1-9]\d*)(?:[?#][^\s]*)?$/i.exec(target);
    if (match && ((command === "pr" && match[3] === "pull") || (command === "issue" && match[3] === "issues"))) {
      const actual = repository(`${match[1]}/${match[2]}`);
      return actual ? { repo: actual } : undefined;
    }
    // Branch selectors may contain a slash; URLs/foreign targets remain ambiguous.
    if (!(command === "pr" && !target.includes(":") && !target.includes("\\") && !target.startsWith("/"))) return undefined;
  }
  return current ? { repo: current } : undefined;
};
