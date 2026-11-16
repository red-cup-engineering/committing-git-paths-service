import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  write("src/staged.mjs", "export const staged = 300;\n");
  write("src/runtime.mjs", "export const runtime = 22;\n");

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
  assert.equal(read("src/staged.mjs"), "export const staged = 300;\n");
  assert.equal(read("src/runtime.mjs"), "export const runtime = 22;\n");
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

test("a producer digest qualifies the actual Git blob and refuses changed bytes before moving the ref", t => {
  const { repository, git, write, env, parent } = checkout(t);
  const lockfile="package-lock.json", received='{"name":"fixture","lockfileVersion":3}\n';
  write(lockfile, received+"\n");
  const expected={ [lockfile]:"sha256:"+createHash("sha256").update(received).digest("hex") };
  const expectedPath=join(repository,"producer-digests.json");
  write("producer-digests.json",JSON.stringify(expected));
  const selected=["--repository",repository,"--path",lockfile,"--expected-file-digests",expectedPath,"--message","Receive qualified lock"];
  const indexBefore=git("ls-files","--stage");
  assert.throws(()=>commitGitExactFiles({repository,paths:[lockfile],message:"Receive lock",expectedFileDigests:expected}),
    {code:"SELECTED_FILE_DIGEST_MISMATCH"});
  assert.equal(git("rev-parse","HEAD").trim(),parent);
  assert.equal(git("ls-files","--stage"),indexBefore);
  git("config","core.autocrlf","true");
  write(lockfile,received.replaceAll("\n","\r\n"));
  const result=JSON.parse(execFileSync(process.execPath,[cli,...selected],{cwd:repository,env,encoding:"utf8"}));
  assert.equal(result.committed,true);
  assert.deepEqual(result.committedPaths,[lockfile]);
  assert.equal(git("show",`HEAD:${lockfile}`),received);
});

test("qualified branch and parent refuse stale receiving before writing any Git ref or index", t => {
  const { repository, git, write, env, parent } = checkout(t);
  const file="package-lock.json", received='{"lockfileVersion":3}\n';
  const expectedFileDigests={ [file]:"sha256:"+createHash("sha256").update(received).digest("hex") };
  const expectedHead={ref:"refs/heads/main",commit:parent};
  write(file,received);
  git("branch","other");
  git("switch","-q","other");
  const indexBefore=git("ls-files","--stage"), refsBefore=git("show-ref");
  const options={repository,paths:[file],message:"Receive lock",expectedHead,expectedFileDigests};
  const differentBranch=commitGitExactFiles(options);
  assert.equal(differentBranch.reason,"source-head-mismatch");
  assert.equal(differentBranch.ref,"refs/heads/other");
  assert.equal(differentBranch.parent,parent);
  assert.equal(git("show-ref"),refsBefore);
  assert.equal(git("ls-files","--stage"),indexBefore);
  assert.equal(git("for-each-ref","refs/commit-git-exact-files/witness"),"");

  git("switch","-q","main");
  write("src/runtime.mjs","export const runtime = 2;\n");
  git("commit","-qm","Independent main-branch change","--","src/runtime.mjs");
  const advanced=git("rev-parse","HEAD").trim();
  assert.equal(commitGitExactFiles({...options,dryRun:true}).reason,"source-head-mismatch");
  assert.equal(commitGitExactFiles(options).reason,"source-head-mismatch");
  assert.equal(git("rev-parse","HEAD").trim(),advanced);
  assert.equal(git("for-each-ref","refs/commit-git-exact-files/witness"),"");

  write("expected-head.json",JSON.stringify({...expectedHead,commit:advanced}));
  write("expected-digests.json",JSON.stringify(expectedFileDigests));
  const result=JSON.parse(execFileSync(process.execPath,[cli,"--repository",repository,
    "--path",file,"--expected-head",join(repository,"expected-head.json"),
    "--expected-file-digests",join(repository,"expected-digests.json"),"--message","Receive lock"],
    {cwd:repository,env,encoding:"utf8"}));
  assert.equal(result.committed,true);
  assert.equal(result.parent,advanced);
  assert.equal(git("show",`HEAD:${file}`),received);
});

test("lost index-lock identity or bytes cannot advance the ref or replace the real index", async t => {
  for (const mode of ["replacement-inode", "changed-bytes"]) await t.test(mode, t => {
    const {repository,git,parent,write}=checkout(t);
    write("src/staged.mjs","export const staged = 2;\n");
    git("add","src/staged.mjs");
    write("package.json",'{"name":"qualified"}\n');
    const index=join(repository,".git","index"),lock=index+".lock";
    const saved=readFileSync(index), foreign=Buffer.from("independent Git lock owner\n");
    const result=commitGitExactFiles({repository,paths:["package.json"],message:"Receive package edit",beforeInstall(){
      if (mode==="replacement-inode") renameSync(lock,lock+".prior");
      writeFileSync(lock,foreign);
    }});
    assert.equal(result.committed,false);
    assert.equal(result.reason,"index-reconciliation-lost");
    assert.equal(result.indexReconciled,false);
    assert.equal(git("rev-parse","HEAD").trim(),parent);
    assert.equal(git("rev-parse",result.witnessRef).trim(),result.candidate);
    assert.deepEqual(readFileSync(index),saved);
    assert.deepEqual(readFileSync(lock),foreign);
  });
});

test("lock loss during actual Git ref commit reports the moved ref without installing a foreign index", t => {
  const {repository,git,write,parent}=checkout(t);
  const index=join(repository,".git","index"), lock=index+".lock";
  write("src/staged.mjs","export const staged = 3;\n");git("add","src/staged.mjs");
  write("package.json",'{"name":"qualified"}\n');
  const saved=readFileSync(index);
  const hook=join(repository,".git","hooks","reference-transaction");
  writeFileSync(hook,`#!/bin/sh
if [ "$1" = committed ]; then
  while read -r before after ref; do
    if [ "$ref" = refs/heads/main ]; then
      mv .git/index.lock .git/index.lock.original
      printf 'foreign lock after ref commit\\n' > .git/index.lock
    fi
  done
fi
`,{mode:0o755});
  const result=commitGitExactFiles({repository,paths:["package.json"],message:"Receive qualified package"});
  assert.equal(result.committed,true);
  assert.equal(result.reason,"index-reconciliation-lost");
  assert.equal(result.indexReconciled,false);
  assert.equal(git("rev-parse","HEAD").trim(),result.head);
  assert.equal(git("rev-parse","HEAD^").trim(),parent);
  assert.equal(git("rev-parse",result.witnessRef).trim(),result.head);
  assert.deepEqual(readFileSync(index),saved);
  assert.equal(readFileSync(lock,"utf8"),"foreign lock after ref commit\n");
});

test("detached HEAD is not a target for an exact-file receiving operation", t => {
  const {repository,git,write,parent}=checkout(t);
  git("switch","--detach","-q",parent);
  write("package.json",'{"name":"qualified"}\n');
  const index=join(repository,".git","index"),before=readFileSync(index);
  const result=commitGitExactFiles({repository,paths:["package.json"],message:"Receive package edit"});
  assert.equal(result.committed,false);
  assert.equal(result.reason,"no-checked-out-branch");
  assert.equal(git("rev-parse","HEAD").trim(),parent);
  assert.equal(git("rev-parse","refs/heads/main").trim(),parent);
  assert.equal(git("for-each-ref","refs/commit-git-exact-files/witness"),"");
  assert.deepEqual(readFileSync(index),before);
});

test("a ref-transaction HEAD retarget never installs the old checkout's index", t => {
  const {repository,git,write,parent}=checkout(t);
  git("branch","other",parent);
  write("src/staged.mjs","export const staged = 4;\n");git("add","src/staged.mjs");
  write("package.json",'{"name":"qualified"}\n');
  const index=join(repository,".git","index"),before=readFileSync(index);
  writeFileSync(join(repository,".git","hooks","reference-transaction"),`#!/bin/sh
if [ "$1" = committed ]; then
  while read -r before after ref; do
    if [ "$ref" = refs/heads/main ]; then
      git symbolic-ref HEAD refs/heads/other
    fi
  done
fi
`,{mode:0o755});
  const result=commitGitExactFiles({repository,paths:["package.json"],message:"Receive qualified package"});
  assert.equal(result.committed,true);
  assert.equal(result.reason,"source-head-changed-after-commit");
  assert.equal(result.indexReconciled,false);
  assert.equal(git("symbolic-ref","HEAD").trim(),"refs/heads/other");
  assert.equal(git("rev-parse","refs/heads/main").trim(),result.head);
  assert.equal(git("rev-parse","HEAD").trim(),parent);
  assert.equal(git("rev-parse",result.witnessRef).trim(),result.head);
  assert.deepEqual(readFileSync(index),before);
});

test("an explicit two-endpoint rename stays literal and leaves outside staged deletion intact", t => {
  const { repository, git, write, read } = checkout(t);
  const from = "src/runtime.mjs";
  const to = "src/runtime[1].mjs";
  const neighbor = "src/runtime1.mjs";
  write(neighbor, "export const neighbor = 1;\n");
  git("add", "--", neighbor);
  git("commit", "-qm", "Add similarly named source");
  const parent = git("rev-parse", "HEAD").trim();
  const bytes = read(from);
  renameSync(join(repository, from), join(repository, to));
  git("rm", "-q", "--", "src/staged.mjs");
  write(neighbor, "export const neighbor = 2;\n");

  const result = commitGitExactFiles({
    repository, paths: [from, to], message: "Rename selected source endpoints",
    expectedHead: { ref: "refs/heads/main", commit: parent },
  });
  assert.equal(result.committed, true);
  assert.equal(result.indexReconciled, true);
  assert.deepEqual(new Set(result.committedPaths), new Set([from, to]));
  assert.equal(git("diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", "HEAD"),
    "D\tsrc/runtime.mjs\nA\tsrc/runtime[1].mjs\n");
  assert.equal(git("show", "HEAD:" + to), bytes);
  assert.equal(git("show", "HEAD:" + neighbor), "export const neighbor = 1;\n");
  assert.equal(read(neighbor), "export const neighbor = 2;\n");
  assert.equal(git("diff", "--cached", "--name-status"), "D\tsrc/staged.mjs\n");
});
