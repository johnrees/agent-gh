import { expect, test } from "bun:test";
import { publicRead } from "../src/public-read.ts";

const cwd = { owner: "unrelated", name: "private-checkout" };
const target = { owner: "lalalune", name: "pumpfun-source" };

test("known repository reads retain their current target when no other target is named", () => {
  for (const args of [
    ["pr", "view", "253", "--comments", "--json", "body,comments", "--jq", ".body"],
    ["pr", "list", "--state", "all", "--limit", "100"],
    ["pr", "diff", "253", "--patch"],
    ["pr", "checks", "253", "--watch", "--interval", "10"],
    ["pr", "status", "--conflict-status"],
    ["issue", "view", "104", "-c"], ["issue", "list", "-sall", "-L100"], ["issue", "status"],
    ["repo", "view", "--branch", "main"],
    ["release", "view", "v1.0"], ["release", "list", "--exclude-drafts"],
    ["release", "download", "v1.0", "--pattern", "*.tar.gz", "--dir", "/tmp/releases"],
  ]) expect(publicRead(args, cwd)).toEqual({ repo: cwd });
});

test("repository flag spellings and short clusters use gh's actual last target", () => {
  for (const args of [
    ["-R", "lalalune/pumpfun-source", "pr", "view", "1"],
    ["--repo=lalalune/pumpfun-source", "pr", "list"],
    ["pr", "-Rlalalune/pumpfun-source", "view", "1"],
    ["pr", "view", "1", "-cR=lalalune/pumpfun-source"],
    ["pr", "view", "1", "-R", "old/repo", "--repo", "lalalune/pumpfun-source"],
    ["pr", "view", "--repo=https://github.com/lalalune/pumpfun-source", "1"],
  ]) expect(publicRead(args, cwd)).toEqual({ repo: target });
});

test("explicit PR/issue URLs and repo-view arguments override unrelated cwd and repo flags", () => {
  for (const args of [
    ["pr", "view", "https://github.com/lalalune/pumpfun-source/pull/253"],
    ["pr", "diff", "https://github.com/lalalune/pumpfun-source/pull/253#discussion", "-R", "wrong/private"],
    ["pr", "checks", "https://github.com/lalalune/pumpfun-source/pull/253"],
    ["issue", "view", "https://github.com/lalalune/pumpfun-source/issues/270?x=1"],
    ["repo", "view", "lalalune/pumpfun-source"],
    ["repo", "view", "https://github.com/lalalune/pumpfun-source/"],
  ]) {
    expect(publicRead(args, cwd)).toEqual({ repo: target });
    expect(publicRead(args, undefined)).toEqual({ repo: target });
  }
  // The parser does not declare a target public; the caller must check this actual target.
  expect(publicRead(["pr", "view", "https://github.com/other/private/pull/2"], target)).toEqual({ repo: { owner: "other", name: "private" } });
});

test("global and owner-scoped known reads never inherit a random checkout", () => {
  for (const args of [
    ["repo", "list"], ["repo", "list", "lalalune", "--visibility", "public"],
    ["search", "code", "finish_grow", "--language", "Rust", "--repo", "lalalune/pumpfun-source"],
    ["search", "issues", "allocator", "--state", "closed"],
    ["search", "prs", "allocator", "context", "--sort", "updated"],
    ["search", "repos", "solana"], ["search", "commits", "fix"],
    ["api", "user"], ["api", "search/code?q=solana"],
  ]) expect(publicRead(args, cwd)).toEqual({ repo: undefined });
});

test("REST GET reuses the method gate and resolves actual repository endpoints", () => {
  for (const args of [
    ["api", "repos/lalalune/pumpfun-source/issues?state=all", "--paginate"],
    ["api", "-XGET", "/repos/lalalune/pumpfun-source/pulls/253"],
    ["api", "https://api.github.com/repos/lalalune/pumpfun-source/git/blobs/abc"],
    ["api", "repos/lalalune/pumpfun-source/issues", "-f", "state=all", "--method", "GET"],
    ["api", "repos/lalalune/pumpfun-source/issues", "-iXGET", "--hostname=github.com", "-HAccept: application/vnd.github+json"],
    ["api", "--method", "POST", "repos/lalalune/pumpfun-source/issues", "--method=GET"],
  ]) expect(publicRead(args, cwd)).toEqual({ repo: target });
  expect(publicRead(["api", "repos/{owner}/{repo}/issues"], cwd)).toEqual({ repo: cwd });
  expect(publicRead(["api", "repos/{owner}/{repo}/issues"], undefined)).toBeUndefined();
});

test("writes, aliases, extensions and unknown operations never receive a read grant", () => {
  for (const args of [
    ["pr", "comment", "1", "--body", "hi"], ["issue", "comment", "1", "--body", "hi"],
    ["pr", "review", "1", "--approve"], ["pr", "merge", "1"], ["pr", "ready", "1"],
    ["issue", "edit", "1"], ["issue", "react", "1"], ["repo", "edit"],
    ["release", "create", "v1"], ["release", "edit", "v1"], ["release", "delete", "v1"],
    ["extension", "exec", "something"], ["my-read-alias", "1"], ["search", "new-command", "query"],
    ["api", "repos/o/r/issues", "-XPOST"], ["api", "repos/o/r/issues", "--method=PATCH"],
    ["api", "repos/o/r/issues/1/reactions", "-fcontent=+1"],
    ["api", "repos/o/r/issues", "--field", "title=hello"],
    ["api", "repos/o/r/issues", "--input", "body.json"],
    ["api", "repos/o/r/issues", "-ifstate=open"],
    ["api", "graphql", "-f", "query=mutation { deleteIssue(input:{}) { clientMutationId } }"],
    ["api", "graphql", "-XGET", "-f", "query=query { viewer { login } }"],
    ["api", "/GRAPHQL", "-XGET"], ["api", "https://api.github.com/graphql", "-XGET"],
  ]) expect(publicRead(args, cwd)).toBeUndefined();
});

test("unknown flags and their values cannot be mistaken for commands, verbs or targets", () => {
  for (const args of [
    ["--new-global", "pr", "view", "1"], ["--config", "pr", "view", "1"],
    ["pr", "--new-flag", "view", "1"], ["pr", "--json", "view", "1"],
    ["pr", "view", "1", "--future-write-mode"], ["pr", "view", "1", "-cz"],
    ["pr", "view", "1", "--comments=maybe"], ["pr", "view", "--repo"],
    ["api", "repos/o/r/issues", "--unknown"], ["api", "-ZPOST", "repos/o/r/issues"],
    ["api", "repos/o/r/issues", "--method"], ["api", "repos/o/r/issues", "extra"],
    ["api", "repos/o/r/issues", "--input=", "-XGET"],
    ["pr", "view", "1", "--", "--new-flag"], ["--", "pr", "view", "1"],
  ]) expect(publicRead(args, cwd)).toBeUndefined();
});

test("unknown hosts, malformed or ambiguous repository targets fail closed", () => {
  for (const args of [
    ["pr", "view", "https://evil.example/o/r/pull/1"],
    ["issue", "view", "https://github.com/o/r/pull/1"],
    ["pr", "view", "https://github.com/o/r/issues/1"],
    ["pr", "view", "https://user@github.com/o/r/pull/1"],
    ["repo", "view", "https://enterprise.example/o/r"], ["repo", "view", "o/../r"],
    ["repo", "view", "https://github.com/o/r?x=1"], ["repo", "view", "../r"],
    ["pr", "view", "1", "--repo", "enterprise.example/o/r"],
    ["api", "https://evil.example/repos/o/r/issues"], ["api", "http://api.github.com/repos/o/r/issues"],
    ["api", "https://api.github.com:443/repos/o/r/issues"],
    ["api", "repos/o/r/issues", "--hostname", "enterprise.example"],
    ["api", "repos/o/r/issues", "-H", "Host: evil.example"],
    ["api", "repos/o/r/issues", "-H", "X-HTTP-Method-Override: POST"],
    ["api", "repos/o/r/../private/issues"], ["api", "repos/o/r%2fother/issues"],
    ["api", "repos/o/{repo}/issues"], ["api", "repos/{owner}/r/issues"],
    ["api", "repositories/123/issues"], ["api", "repos/o"],
    ["api", "repos/o/r/issues", "-R", "other/repo"],
  ]) expect(publicRead(args, cwd)).toBeUndefined();
  for (const args of [["pr", "view", "1"], ["issue", "list"], ["release", "view"], ["repo", "view"]]) expect(publicRead(args, undefined)).toBeUndefined();
});
