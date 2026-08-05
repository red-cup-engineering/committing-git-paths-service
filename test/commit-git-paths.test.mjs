import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { commitGitPaths } from "../scripts/commit-git-paths.mjs";

const gitBin = "/usr/bin/git";

test("commitGitPaths commits only explicitly selected paths", async () => {
  const repository = await mkdtemp(join(tmpdir(), "commit-git-paths-"));
  try {
    git(repository, ["init", "-q"]);
    await writeFile(join(repository, "selected.txt"), "one\n");
    await writeFile(join(repository, "unrelated.txt"), "one\n");
    git(repository, ["add", "."]);
    git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(repository, "selected.txt"), "two\n");
    await writeFile(join(repository, "unrelated.txt"), "two\n");

    const result = commitGitPaths({ repository, paths: ["selected.txt"], message: "Update selected", gitBin });
    assert.equal(result.committed, true);
    assert.deepEqual(result.committedPaths, ["selected.txt"]);
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]).trim(), "two");
    assert.equal(git(repository, ["show", "HEAD:unrelated.txt"]).trim(), "one");
    assert.equal(await readFile(join(repository, "unrelated.txt"), "utf8"), "two\n");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths refuses unrelated staged work without staging its requested path", async () => {
  const repository = await mkdtemp(join(tmpdir(), "commit-git-paths-refusal-"));
  try {
    git(repository, ["init", "-q"]);
    await writeFile(join(repository, "selected.txt"), "one\n");
    await writeFile(join(repository, "unrelated.txt"), "one\n");
    git(repository, ["add", "."]);
    git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    await writeFile(join(repository, "selected.txt"), "two\n");
    await writeFile(join(repository, "unrelated.txt"), "two\n");
    git(repository, ["add", "unrelated.txt"]);

    assert.throws(
      () => commitGitPaths({ repository, paths: ["selected.txt"], message: "Update selected", gitBin }),
      /already-staged paths: unrelated\.txt/u,
    );
    assert.deepEqual(git(repository, ["diff", "--cached", "--name-only"]).trim().split("\n"), ["unrelated.txt"]);
    assert.equal(git(repository, ["diff", "--cached", "--name-only", "--", "selected.txt"]), "");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return execFileSync(gitBin, args, { cwd, encoding: "utf8" });
}
