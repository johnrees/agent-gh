import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
