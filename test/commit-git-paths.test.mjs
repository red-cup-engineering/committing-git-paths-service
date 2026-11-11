import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { commitGitExactFiles, commitGitPaths, parseArgs, readPathsFile } from "../scripts/commit-git-paths.mjs";

const gitBin = "/usr/bin/git";
const cliPath = fileURLToPath(new URL("../scripts/commit-git-paths.mjs", import.meta.url));

test("commitGitPaths commits a same-size selected edit only", async () => {
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

test("commitGitPaths isolates unrelated staged work", async () => {
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

    const before = git(repository, ["ls-files", "--stage", "-z"]);
    const result = commitGitPaths({ repository, paths: ["selected.txt"], message: "Update selected", gitBin });
    assert.equal(result.committed, true);
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]).trim(), "two");
    assert.equal(indexTuple(before, "unrelated.txt"), indexTuple(git(repository, ["ls-files", "--stage", "-z"]), "unrelated.txt"));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commit-git-paths CLI commits an explicit file while staged and unstaged work stays outside", async () => {
  const repository = await fixture("commit-git-paths-cli-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    await writeFile(join(repository, "unrelated.txt"), "staged\n");
    await writeFile(join(repository, "deleted.txt"), "unstaged\n");
    git(repository, ["add", "unrelated.txt"]);
    const before = git(repository, ["ls-files", "--stage", "-z"]);
    const output = execFileSync(process.execPath, [cliPath, "--repository", repository, "--path", "selected.txt", "--message", "CLI exact update"], { encoding: "utf8" });
    assert.equal(JSON.parse(output).committed, true);
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]).trim(), "two");
    assert.equal(indexTuple(before, "unrelated.txt"), indexTuple(git(repository, ["ls-files", "--stage", "-z"]), "unrelated.txt"));
    assert.equal(await readFile(join(repository, "deleted.txt"), "utf8"), "unstaged\n");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commit-git-paths runs through a symlink for dry-run and commit", async () => {
  const repository = await fixture("commit-git-paths-cli-symlink-");
  try {
    const linkedCli = join(repository, "commit-git-paths-link.mjs");
    await symlink(cliPath, linkedCli);
    await writeFile(join(repository, "selected.txt"), "two\n");
    const dryRun = JSON.parse(execFileSync(process.execPath, [linkedCli, "--repository", repository, "--path", "selected.txt", "--message", "Linked dry run", "--dry-run"], { encoding: "utf8" }));
    assert.equal(dryRun.reason, "dry-run");
    const committed = JSON.parse(execFileSync(process.execPath, [linkedCli, "--repository", repository, "--path", "selected.txt", "--message", "Linked commit"], { encoding: "utf8" }));
    assert.equal(committed.committed, true);
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]).trim(), "two");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("importing commit-git-paths has no CLI side effect", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'import("./scripts/commit-git-paths.mjs")'], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" });
  assert.equal(output, "");
});

test("commitGitExactFiles commits selected additions, modifications, and deletions without changing outside staged tuples", async () => {
  const repository = await fixture("commit-git-exact-files-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    await writeFile(join(repository, "added.txt"), "new\n");
    await rm(join(repository, "deleted.txt"));
    await writeFile(join(repository, "unrelated.txt"), "staged\n");
    git(repository, ["add", "unrelated.txt"]);
    const before = git(repository, ["ls-files", "--stage", "-z"]);
    const parent = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = commitGitExactFiles({ repository, paths: ["selected.txt", "added.txt", "deleted.txt"], message: "Exact update", gitBin });

    assert.equal(result.committed, true);
    assert.equal(result.parent, parent);
    assert.deepEqual([...result.committedPaths].sort(), ["added.txt", "deleted.txt", "selected.txt"]);
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]).trim(), "two");
    assert.equal(git(repository, ["show", "HEAD:added.txt"]).trim(), "new");
    assert.notEqual(gitStatus(repository, ["cat-file", "-e", "HEAD:deleted.txt"]), 0);
    assert.equal(git(repository, ["rev-parse", "HEAD^"]).trim(), parent);
    assert.equal(indexTuple(before, "unrelated.txt"), indexTuple(git(repository, ["ls-files", "--stage", "-z"]), "unrelated.txt"));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths treats pathspec-looking names as literal endpoints", async () => {
  const repository = await fixture("commit-git-exact-literal-");
  const literal = ":(literal)notice.txt";
  try {
    await writeFile(join(repository, literal), "literal\n");
    const result = commitGitPaths({ repository, paths: [literal], message: "Literal endpoint", gitBin });
    assert.equal(result.committed, true);
    assert.equal(git(repository, ["show", `HEAD:${literal}`]).trim(), "literal");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths preserves selected symlink bytes", async () => {
  const repository = await fixture("commit-git-exact-symlink-file-");
  try {
    await symlink("selected.txt", join(repository, "linked-file"));
    const result = commitGitPaths({ repository, paths: ["linked-file"], message: "Link endpoint", gitBin });
    assert.equal(result.committed, true);
    assert.equal(git(repository, ["show", "HEAD:linked-file"]), "selected.txt");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths follows Git clean-filter and core.filemode semantics", async () => {
  const repository = await fixture("commit-git-exact-git-semantics-");
  try {
    git(repository, ["config", "filter.fixture.clean", "sed 's/worktree/canonical/'"]);
    git(repository, ["config", "core.filemode", "false"]);
    await writeFile(join(repository, ".gitattributes"), "selected.txt filter=fixture\n");
    await writeFile(join(repository, "selected.txt"), "worktree\n");
    chmodSync(join(repository, "selected.txt"), 0o755);
    const result = commitGitPaths({ repository, paths: ["selected.txt"], message: "Git semantics", gitBin });
    assert.equal(result.committed, true);
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]), "canonical\n");
    assert.match(git(repository, ["ls-tree", "HEAD", "selected.txt"]), /^100644 /u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths commits both literal endpoints of a rename", async () => {
  const repository = await fixture("commit-git-exact-rename-");
  try {
    await rm(join(repository, "selected.txt"));
    await writeFile(join(repository, "renamed.txt"), "one\n");
    const result = commitGitPaths({ repository, paths: ["selected.txt", "renamed.txt"], message: "Rename endpoint", gitBin });
    assert.equal(result.committed, true);
    assert.deepEqual([...result.committedPaths].sort(), ["renamed.txt", "selected.txt"]);
    assert.equal(git(repository, ["show", "HEAD:renamed.txt"]).trim(), "one");
    assert.notEqual(gitStatus(repository, ["cat-file", "-e", "HEAD:selected.txt"]), 0);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths commits a staged tracked ignored rename endpoint without admitting ignored untracked files", async () => {
  const repository = await fixture("commit-git-exact-ignored-rename-");
  try {
    await writeFile(join(repository, ".gitignore"), "*.jsonl\n");
    await writeFile(join(repository, "legacy.jsonl"), "old\n");
    git(repository, ["add", "-f", ".gitignore", "legacy.jsonl"]);
    git(repository, ["commit", "-qm", "tracked legacy"]);
    await rm(join(repository, "legacy.jsonl"));
    await writeFile(join(repository, "relocated.jsonl"), "old\n");
    await writeFile(join(repository, "private.jsonl"), "private\n");
    git(repository, ["add", "-f", "relocated.jsonl"]);
    const before = git(repository, ["ls-files", "--stage", "-z"]);

    const result = commitGitPaths({ repository, paths: ["legacy.jsonl", "relocated.jsonl"], message: "Relocate tracked ignored record", gitBin });

    assert.equal(result.committed, true);
    assert.equal(git(repository, ["show", "HEAD:relocated.jsonl"]), "old\n");
    assert.notEqual(gitStatus(repository, ["cat-file", "-e", "HEAD:legacy.jsonl"]), 0);
    assert.equal(indexTuple(before, "private.jsonl"), undefined);
    assert.match(git(repository, ["status", "--short", "--ignored"]), /!! private\.jsonl/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles rejects directory endpoints", async () => {
  const repository = await fixture("commit-git-exact-directory-");
  try {
    await assert.rejects(async () => commitGitExactFiles({ repository, paths: ["directory"], message: "Directory", gitBin }), /directories are not file endpoints/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths dry-run validates exact endpoints without mutation", async () => {
  const repository = await fixture("commit-git-exact-dry-run-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    const head = git(repository, ["rev-parse", "HEAD"]).trim();
    const index = git(repository, ["ls-files", "--stage", "-z"]);
    const result = commitGitPaths({ repository, paths: ["selected.txt"], message: "Dry run", dryRun: true, gitBin });
    assert.deepEqual(result, { repository, paths: ["selected.txt"], message: "Dry run", dryRun: true, committed: false, parent: head, reason: "dry-run" });
    assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), head);
    assert.equal(git(repository, ["ls-files", "--stage", "-z"]), index);
    assert.equal(await readFile(join(repository, "selected.txt"), "utf8"), "two\n");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitPaths returns an honest no-op for unchanged endpoints", async () => {
  const repository = await fixture("commit-git-paths-no-op-");
  try {
    const result = commitGitPaths({ repository, paths: ["selected.txt"], message: "No-op", gitBin });
    assert.equal(result.committed, false);
    assert.equal(result.reason, "nothing-staged");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles refuses a selected worktree change before installation", async () => {
  const repository = await fixture("commit-git-exact-worktree-race-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    const head = git(repository, ["rev-parse", "HEAD"]).trim();
    const result = commitGitExactFiles({ repository, paths: ["selected.txt"], message: "Candidate", gitBin, beforeInstall: () => writeFileSync(join(repository, "selected.txt"), "three\n") });
    assert.equal(result.committed, false);
    assert.equal(result.reason, "selected-worktree-changed");
    assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), head);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles releases its index lock when a callback throws", async () => {
  const repository = await fixture("commit-git-exact-callback-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    assert.throws(() => commitGitExactFiles({ repository, paths: ["selected.txt"], message: "Callback", gitBin, beforeInstall: () => { throw new Error("stop"); } }), /stop/u);
    assert.equal(existsSync(join(repository, ".git", "index.lock")), false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles preserves a preexisting index lock", async () => {
  const repository = await fixture("commit-git-exact-existing-lock-");
  const lock = join(repository, ".git", "index.lock");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    writeFileSync(lock, "foreign lock sentinel\n");
    assert.throws(() => commitGitExactFiles({ repository, paths: ["selected.txt"], message: "Locked", gitBin }), /EEXIST/u);
    assert.equal(readFileSync(lock, "utf8"), "foreign lock sentinel\n");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles runs post-commit after ref and index reconciliation", async () => {
  const repository = await fixture("commit-git-exact-post-commit-");
  const receipt = join(repository, "post-commit-receipt.txt");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    await writeFile(join(repository, ".git", "hooks", "post-commit"), `#!/bin/sh\ngit rev-parse HEAD > ${receipt}\ngit diff --cached --name-only >> ${receipt}\n`);
    chmodSync(join(repository, ".git", "hooks", "post-commit"), 0o755);
    const result = commitGitExactFiles({ repository, paths: ["selected.txt"], message: "Hook", gitBin });
    assert.equal(result.committed, true);
    assert.deepEqual(result.postCommit, { ran: true, success: true, output: "" });
    assert.equal(readFileSync(receipt, "utf8"), `${result.head}\n`);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles reports a post-commit failure after installation", async () => {
  const repository = await fixture("commit-git-exact-post-commit-failure-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    await writeFile(join(repository, ".git", "hooks", "post-commit"), "#!/bin/sh\necho hook failed >&2\nexit 1\n");
    chmodSync(join(repository, ".git", "hooks", "post-commit"), 0o755);
    const result = commitGitExactFiles({ repository, paths: ["selected.txt"], message: "Hook failure", gitBin });
    assert.equal(result.committed, true);
    assert.deepEqual(result.postCommit, { ran: true, success: false, output: "hook failed" });
    assert.equal(git(repository, ["rev-parse", "HEAD"]).trim(), result.head);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles rejects Git metadata and symlink-directory endpoints", async () => {
  const repository = await fixture("commit-git-exact-boundary-");
  try {
    await symlink("directory", join(repository, "linked-directory"));
    assert.throws(() => commitGitExactFiles({ repository, paths: [".git/config"], message: "Metadata", gitBin }), /Git metadata endpoints/u);
    assert.throws(() => commitGitExactFiles({ repository, paths: ["linked-directory/placeholder.txt"], message: "Symlink", gitBin }), /symlink directory endpoints/u);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles preserves an advanced ref and returns its candidate witness", async () => {
  const repository = await fixture("commit-git-exact-race-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    const parent = git(repository, ["rev-parse", "HEAD"]).trim();
    const before = git(repository, ["ls-files", "--stage", "-z"]);
    const result = commitGitExactFiles({
      repository,
      paths: ["selected.txt"],
      message: "Candidate",
      gitBin,
      beforeInstall: () => advanceHeadWithoutIndex(repository, parent),
    });
    const advanced = git(repository, ["rev-parse", "HEAD"]).trim();
    assert.equal(result.committed, false);
    assert.equal(result.reason, "head-advanced");
    assert.match(result.candidate, /^[0-9a-f]{40}$/u);
    assert.equal(git(repository, ["rev-parse", result.witnessRef]).trim(), result.candidate);
    assert.notEqual(advanced, result.candidate);
    assert.notEqual(advanced, parent);
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]).trim(), "one");
    assert.equal(git(repository, ["ls-files", "--stage", "-z"]), before);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles refuses a branch switch before compare-and-swap", async () => {
  const repository = await fixture("commit-git-exact-switch-");
  try {
    await writeFile(join(repository, "selected.txt"), "two\n");
    git(repository, ["branch", "other"]);
    const result = commitGitExactFiles({
      repository,
      paths: ["selected.txt"],
      message: "Candidate",
      gitBin,
      beforeInstall: () => git(repository, ["symbolic-ref", "HEAD", "refs/heads/other"]),
    });
    assert.equal(result.committed, false);
    assert.equal(result.reason, "head-advanced");
    assert.equal(git(repository, ["branch", "--show-current"]).trim(), "other");
    assert.equal(git(repository, ["show", "HEAD:selected.txt"]).trim(), "one");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitGitExactFiles commits a path list too large for a single argv (regression: OS ARG_MAX)", async () => {
  const repository = await fixture("commit-git-exact-argv-scale-");
  try {
    const fileCount = 14_000;
    const longNamePadding = "x".repeat(170);
    const names = Array.from({ length: fileCount }, (_, index) => `${longNamePadding}-${index}.txt`);
    const totalPathBytes = names.reduce((sum, name) => sum + Buffer.byteLength(name) + 1, 0);
    assert.ok(totalPathBytes > 2 * 1024 * 1024, `fixture must exceed a 2MiB argv budget to prove the regression, got ${totalPathBytes}`);
    await Promise.all(names.map((name) => writeFile(join(repository, name), "x\n")));

    const result = commitGitExactFiles({ repository, paths: names, message: "Bulk add past the OS argv-size limit", gitBin });

    assert.equal(result.committed, true);
    assert.equal(result.committedPaths.length, fileCount);
    assert.equal(git(repository, ["cat-file", "-e", `HEAD:${names[0]}`]).length, 0);
    assert.equal(git(repository, ["cat-file", "-e", `HEAD:${names.at(-1)}`]).length, 0);
    assert.equal(git(repository, ["ls-files"]).trim().split("\n").length, fileCount + 4);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

async function fixture(prefix) {
  const repository = await mkdtemp(join(tmpdir(), prefix));
  git(repository, ["init", "-q"]);
  await writeFile(join(repository, "selected.txt"), "one\n");
  await writeFile(join(repository, "deleted.txt"), "one\n");
  await writeFile(join(repository, "unrelated.txt"), "one\n");
  await mkdir(join(repository, "directory"));
  await writeFile(join(repository, "directory", "placeholder.txt"), "one\n");
  git(repository, ["add", "."]);
  git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  git(repository, ["config", "user.name", "Test"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  return repository;
}

function indexTuple(index, path) {
  return index.split("\0").find((entry) => entry.endsWith(`\t${path}`));
}

function advanceHeadWithoutIndex(repository, parent) {
  const tree = git(repository, ["rev-parse", `${parent}^{tree}`]).trim();
  const advanced = execFileSync(gitBin, ["commit-tree", tree, "-p", parent], { cwd: repository, encoding: "utf8", input: "Concurrent commit\n" }).trim();
  git(repository, ["update-ref", git(repository, ["symbolic-ref", "HEAD"]).trim(), advanced, parent]);
}

function git(cwd, args) {
  return execFileSync(gitBin, args, { cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}

function gitStatus(cwd, args) {
  return spawnSync(gitBin, args, { cwd, encoding: "utf8" }).status;
}

test("--paths-from reads one literal path per line so a commit is never sized by the argument list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commit-git-paths-list-"));
  try {
    const listing = join(directory, "paths.txt");
    await writeFile(listing, "lib/a.mjs\nlib/b.mjs\n\nlib/c.mjs\n");
    assert.deepEqual(readPathsFile(listing), ["lib/a.mjs", "lib/b.mjs", "lib/c.mjs"]);
    const options = parseArgs(["--repository", directory, "--path", "lib/z.mjs", "--paths-from", listing, "--message", "m", "--dry-run"]);
    assert.deepEqual(options.paths, ["lib/z.mjs", "lib/a.mjs", "lib/b.mjs", "lib/c.mjs"]);
    assert.equal(options.dryRun, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
