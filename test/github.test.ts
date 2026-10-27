import { expect, test } from "bun:test";
import { GITHUB, movedTo } from "../src/github.ts";

test("a renamed repository's redirect is followed only to /repositories/ID on the API's own origin", () => {
  for (const location of [
    "https://api.github.com/repositories/1300192",
    "/repositories/1300192",
    "https://API.GitHub.com/repositories/1300192",
    "https://api.github.com:443/repositories/1300192",
  ]) expect(movedTo(GITHUB, location)).toBe(1300192);
  for (const location of [
    null,
    "",
    "http://api.github.com/repositories/1300192",
    "https://api.github.com:8443/repositories/1300192",
    "https://github.com/repositories/1300192",
    "https://api.github.com.evil.example/repositories/1300192",
    "https://evil.example/repositories/1300192",
    "//evil.example/repositories/1300192",
    "https://user:pass@api.github.com/repositories/1300192",
    "https://token@api.github.com/repositories/1300192",
    "https://api.github.com/repositories/1300192?access_token=x",
    "https://api.github.com/repositories/1300192#x",
    "https://api.github.com/repositories/1300192/",
    "https://api.github.com/repositories/1300192/pulls",
    "https://api.github.com/repos/new-owner/new-name",
    "https://api.github.com/repositories/0",
    "https://api.github.com/repositories/01300192",
    "https://api.github.com/repositories/-1",
    "https://api.github.com/repositories/1e6",
    "https://api.github.com/repositories/%31",
    "https://api.github.com/repositories/99999999999999999",
    "javascript:alert(1)",
    "http://[",
  ]) expect(movedTo(GITHUB, location)).toBeUndefined();
});
