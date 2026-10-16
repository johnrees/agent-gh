import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { installBinary } from "../scripts/install-binary.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = join(import.meta.dir, "..", "src", "files.ts");

test("writers of one file at once each finish, leave a whole text, and no temporary file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-files-"));
  const target = join(dir, ".zshrc");
  const writer = join(dir, "writer.ts");
  // Each writer rewrites the file many times with its own long text, so the writes overlap.
  writeFileSync(
    writer,
    `import { writeAtomic } from ${JSON.stringify(files)};\nconst text = process.argv[2]!.repeat(4096);\nfor (let i = 0; i < 200; i++) writeAtomic(${JSON.stringify(target)}, text);\n`,
  );
  const writers = "abcdefgh".split("").map((letter) => Bun.spawn([process.execPath, writer, letter], { stdout: "pipe", stderr: "pipe" }));
  const codes = await Promise.all(writers.map((child) => child.exited));
  const errors = await Promise.all(writers.map((child) => new Response(child.stderr).text()));
  expect(errors.filter((text) => text !== "")).toEqual([]);
  expect(codes).toEqual(Array(8).fill(0));
  expect(readFileSync(target, "utf8")).toMatch(/^([a-h])\1{4095}$/);
  expect(readdirSync(dir).sort()).toEqual([".zshrc", "writer.ts"]);
});

test("install-local leaves an identical installed build alone, and installs a changed one or one with the wrong mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gh-install-local-"));
  const built = join(dir, "dist-agent-gh");
  const target = join(dir, "bin", "agent-gh");
  writeFileSync(built, "build 1");
  expect(installBinary(built, target)).toBe(true);
  const first = statSync(target);
  expect(first.mode & 0o777).toBe(0o755);
  expect(installBinary(built, target)).toBe(false);
  expect(statSync(target).ino).toBe(first.ino);
  writeFileSync(built, "build 2");
  expect(installBinary(built, target)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("build 2");
  chmodSync(target, 0o700);
  expect(installBinary(built, target)).toBe(true);
  expect(statSync(target).mode & 0o777).toBe(0o755);
  expect(readdirSync(join(dir, "bin"))).toEqual(["agent-gh"]);
  // A copy that fails leaves the installed one as it was, and no temporary file.
  const before = readFileSync(target);
  rmSync(built);
  expect(() => installBinary(built, target)).toThrow();
  expect(readFileSync(target)).toEqual(before);
  expect(readdirSync(join(dir, "bin"))).toEqual(["agent-gh"]);
});
