import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commitGitExactFiles } from "@red-cup-engineering/committing-git-paths-service";

const gitBin = "/usr/bin/git";
const cli = fileURLToPath(new URL("../scripts/commit-git-paths.mjs", import.meta.url));

function checkout(t) {
  const repository = mkdtempSync(join(tmpdir(), "exact-git-paths-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: repository, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync(gitBin, args, { cwd: repository, env, encoding: "utf8" });
  const write = (path, value) => writeFileSync(join(repository, path), value);
  const read = path => readFileSync(join(repository, path), "utf8");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Source Receiving Fixture");
  git("config", "user.email", "receiving@example.invalid");
  mkdirSync(join(repository, "src"));
  write("package.json", '{"name":"fixture","description":"before"}\n');
  write("src/runtime.mjs", "export const runtime = 1;\n");
  write("src/staged.mjs", "export const staged = 1;\n");
  git("add", "package.json", "src");
  git("commit", "-qm", "Initialize full package");
  return { repository, git, write, read, env, parent: git("rev-parse", "HEAD").trim() };
}

test("a manifest-only CLI operation preserves the parent tree and outside staged and working bytes", t => {
  const { repository, git, write, read, env, parent } = checkout(t);
  const selected = '{"name":"fixture","description":"normalized"}\n';
  write("package.json", selected);
  write("src/staged.mjs", "export const staged = 2;\n");
  git("add", "src/staged.mjs");
  const stagedIndex = git("ls-files", "--stage", "--", "src/staged.mjs");
  write("src/staged.mjs", "export const staged = 3;\n");
  write("src/runtime.mjs", "export const runtime = 2;\n");

  const result = JSON.parse(execFileSync(process.execPath, [cli, "--repository", repository,
    "--path", "package.json", "--message", "Normalize package description"], { cwd: repository, env, encoding: "utf8" }));
  assert.equal(result.committed, true);
  assert.equal(result.indexReconciled, true);
  assert.equal(git("rev-parse", "HEAD").trim(), result.head);
  assert.equal(git("rev-parse", "HEAD^").trim(), parent);
  assert.equal(git("diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"), "M\tpackage.json\n");
  assert.equal(git("show", "HEAD:package.json"), selected);
  assert.equal(git("ls-tree", "-r", parent, "--", "src"), git("ls-tree", "-r", "HEAD", "--", "src"));
  assert.equal(git("ls-files", "--stage", "--", "src/staged.mjs"), stagedIndex);
  assert.equal(git("diff", "--cached", "--name-only"), "src/staged.mjs\n");
  assert.equal(read("src/staged.mjs"), "export const staged = 3;\n");
  assert.equal(read("src/runtime.mjs"), "export const runtime = 2;\n");
  assert.equal(git("status", "--short"), " M src/runtime.mjs\nMM src/staged.mjs\n");
});

test("a selected worktree change before installation preserves the branch and existing staged data", t => {
  const { repository, git, write, read, parent } = checkout(t);
  write("src/staged.mjs", "export const staged = 2;\n");
  git("add", "src/staged.mjs");
  const indexBefore = git("ls-files", "--stage");
  write("package.json", '{"name":"first-edit"}\n');
  const newer = '{"name":"later-edit"}\n';
  const result = commitGitExactFiles({ repository, paths:["package.json"], message:"Normalize package",
    beforeInstall() { write("package.json", newer); } });
  assert.equal(result.committed, false);
  assert.equal(result.reason, "selected-worktree-changed");
  assert.equal(git("rev-parse", "HEAD").trim(), parent);
  assert.equal(git("ls-files", "--stage"), indexBefore);
  assert.equal(read("package.json"), newer);
});
