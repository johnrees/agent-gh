import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
const ASSET = `agent-gh-${process.platform}-${process.arch}`;
const GITLEAKS = `gitleaks_8.30.1_${process.platform}_${process.arch}.tar.gz`;
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * A release directory served over file://, holding a fake agent-gh that logs
 * each call, and a fake gitleaks release, as install.sh downloads them. The
 * fake agent-gh's `login --all` and `doctor --machine` fail when told to.
 */
const release = ({ loginFails = false, doctorFails = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "agent-gh-release-"));
  const home = join(root, "home");
  mkdirSync(home);
  const log = join(root, "calls");
  const download = join(root, "agent-gh", "latest", "download");
  mkdirSync(download, { recursive: true });
  writeFileSync(
    join(download, ASSET),
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'case "$1" in',
      "  --version) echo 'agent-gh v0.1.0' ;;",
      `  login) exit ${loginFails ? 1 : 0} ;;`,
      `  doctor) exit ${doctorFails ? 1 : 0} ;;`,
      "esac",
      "",
    ].join("\n"),
  );
  writeFileSync(join(download, "SHA256SUMS"), `${"0".repeat(64)}  agent-gh-other\n${sha256(join(download, ASSET))}  ${ASSET}\n`);

  const gitleaks = join(root, "gitleaks", "download", "v8.30.1");
  const staging = join(root, "staging");
  mkdirSync(gitleaks, { recursive: true });
  mkdirSync(staging);
  writeFileSync(join(staging, "gitleaks"), "#!/bin/sh\necho gitleaks 8.30.1\n");
  writeFileSync(join(staging, "LICENSE"), "MIT\n");
  Bun.spawnSync(["tar", "-czf", join(gitleaks, GITLEAKS), "-C", staging, "gitleaks", "LICENSE"]);
  writeFileSync(join(gitleaks, "gitleaks_8.30.1_checksums.txt"), `${sha256(join(gitleaks, GITLEAKS))}  ${GITLEAKS}\n`);

  // As `curl ... | bash -s -- <args>`: the script arrives on stdin.
  const run = (args: string[] = []) => {
    writeFileSync(log, "");
    const result = Bun.spawnSync(["bash", "-s", "--", ...args], {
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        AGENT_GH_RELEASES: `file://${join(root, "agent-gh")}`,
        AGENT_GH_GITLEAKS_RELEASES: `file://${join(root, "gitleaks")}`,
      },
      stdin: new TextEncoder().encode(INSTALL),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, stderr: result.stderr.toString(), calls: readFileSync(log, "utf8").trim().split("\n") };
  };
  return { root, home, download, gitleaks, run, bin: join(home, ".local", "bin") };
};

test("the install line installs the checked agent-gh and gitleaks, then logs in, shims, and checks, and reruns cleanly", () => {
  const { bin, run } = release();
  const first = run();
  expect(first.code).toBe(0);
  expect(first.calls).toEqual(["--version", "--version", "login --all", "install-shims", "doctor --machine"]);
  expect(first.stderr).toContain(`installed agent-gh v0.1.0 at ${bin}/agent-gh`);
  expect(first.stderr).toContain(`installed gitleaks 8.30.1 at ${bin}/gitleaks`);
  expect(readFileSync(join(bin, "gitleaks"), "utf8")).toContain("gitleaks 8.30.1");
  expect(existsSync(join(bin, "LICENSE"))).toBe(false);

  const again = run(["--agent-machine"]);
  expect(again.code).toBe(0);
  expect(again.calls.slice(2)).toEqual(["login --all", "install-shims --agent-machine", "doctor --machine"]);
  expect(again.stderr).toContain("gitleaks: already installed");
});

test("a binary or gitleaks tarball that does not match its checksum is never installed", () => {
  const tampered = release();
  writeFileSync(join(tampered.download, ASSET), "#!/bin/sh\necho planted\n");
  const refused = tampered.run();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(`${ASSET} does not match SHA256SUMS; nothing was installed`);
  expect(existsSync(join(tampered.bin, "agent-gh"))).toBe(false);
  expect(refused.calls).toEqual([""]);

  const leaks = release();
  writeFileSync(join(leaks.gitleaks, "gitleaks_8.30.1_checksums.txt"), `${"f".repeat(64)}  ${GITLEAKS}\n`);
  const noLeaks = leaks.run();
  expect(noLeaks.code).toBe(1);
  expect(noLeaks.stderr).toContain(`${GITLEAKS} does not match gitleaks_8.30.1_checksums.txt; gitleaks was not installed`);
  expect(existsSync(join(leaks.bin, "gitleaks"))).toBe(false);
});

test("a failed login still installs the shims and runs the checklist, and the install line fails", () => {
  const { run } = release({ loginFails: true });
  const result = run();
  expect(result.code).toBe(1);
  expect(result.calls.slice(2)).toEqual(["login --all", "install-shims", "doctor --machine"]);
  expect(release({ doctorFails: true }).run().code).toBe(1);
  expect(release().run(["--agentmachine"]).code).toBe(2);
});
