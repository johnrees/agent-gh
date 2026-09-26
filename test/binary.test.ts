import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

const root = join(import.meta.dir, "..");

/**
 * The compiled binary runs inside other repositories. A standalone Bun executable
 * loads the working directory's bunfig.toml and .env unless built not to: a
 * repository's preload would crash it (soltui's `@opentui/solid/preload`), and a
 * repository's .env could set the variables agent-gh trusts.
 */
test("the compiled binary ignores the working directory's bunfig.toml and .env", async () => {
  const build = packageJson.scripts.build.split(" ");
  expect(build).toContain("--no-compile-autoload-bunfig");
  expect(build).toContain("--no-compile-autoload-dotenv");
  const release = await Bun.file(join(root, ".github", "workflows", "release.yml")).text();
  expect(release).toContain("--no-compile-autoload-bunfig --no-compile-autoload-dotenv");
  const out = join(mkdtempSync(join(tmpdir(), "agent-gh-bin-")), "agent-gh");
  const compile = Bun.spawnSync([process.execPath, ...build.slice(1).filter((arg) => arg !== "dist/agent-gh"), out], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(compile.exitCode).toBe(0);

  const repo = mkdtempSync(join(tmpdir(), "agent-gh-hostile-"));
  writeFileSync(join(repo, "bunfig.toml"), 'preload = ["./does-not-exist.ts"]\n');
  writeFileSync(join(repo, ".env"), "PI_SESSION_ID=planted\nPI_PROVIDER=zai\nPI_MODEL=glm-4.6\n");
  const run = Bun.spawnSync([out, "doctor"], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", HOME: repo },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = run.stderr.toString();
  expect(stderr).not.toContain("does-not-exist");
  expect(stderr).toContain("no agent harness detected");
});
