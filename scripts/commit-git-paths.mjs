#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { commitGitExactFiles } from "../src/commit-git-exact-files.mjs";

export { commitGitExactFiles };
export const commitGitPaths = commitGitExactFiles;

/** Literal repository-relative paths listed one per line in a file, for commits larger than an argument list. */
export function readPathsFile(file) {
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}

export function parseArgs(argv) {
  const options = { paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repository") options.repository = argv[++index];
    else if (argument === "--path") options.paths.push(argv[++index]);
    else if (argument === "--paths-from") options.paths.push(...readPathsFile(argv[++index]));
    else if (argument === "--message") options.message = argv[++index];
    else if (argument === "--git-bin") options.gitBin = argv[++index];
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--across-repositories") options.acrossRepositories = true;
    else if (argument === "--exact-files") options.exactFiles = true;
    else if (argument === "--help") options.help = true;
    else throw new TypeError(`unknown argument: ${argument}`);
  }
  return options;
}

function main({ argv, stdout }) {
  const options = parseArgs(argv);
  if (options.help) {
    stdout.write("usage: commit-git-paths --repository <path> --path <literal-file> [--path <literal-file>...] [--paths-from <file listing one path per line>] --message <message> [--across-repositories] [--dry-run] [--git-bin <path>]\n");
    return;
  }
  stdout.write(`${JSON.stringify(options.acrossRepositories ? commitGitPathsAcrossRepositories(options) : commitGitExactFiles(options))}\n`);
}

/** Commit literal paths by their owning Git repository.  Opt-in keeps the
 * single-repository command's refusal of accidental nested endpoints. */
export function commitGitPathsAcrossRepositories({ repository, paths, message, gitBin, dryRun }) {
  if (!repository || !Array.isArray(paths) || paths.length === 0) throw new TypeError("repository and paths are required");
  const groups = new Map();
  for (const path of paths) {
    if (typeof path !== "string" || path === "" || path.startsWith("/") || path.split("/").includes("..")) throw new TypeError(`path must be repository-relative: ${path}`);
    const owner = git(gitBin, nearestExistingDirectory(dirname(`${repository}/${path}`)), ["rev-parse", "--show-toplevel"]);
    const ownedPath = owner === repository ? path : `${repository}/${path}`.slice(owner.length + 1);
    const group = groups.get(owner) ?? [];
    group.push(ownedPath);
    groups.set(owner, group);
  }
  return Object.freeze([...groups.entries()].map(([root, ownedPaths]) => commitGitExactFiles({ repository: root, paths: ownedPaths, message, gitBin, dryRun })));
}

function nearestExistingDirectory(directory) {
  let cursor = directory;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`no existing parent for ${directory}`);
    cursor = parent;
  }
  return cursor;
}

function git(gitBin = "/usr/bin/git", cwd, args) {
  const result = spawnSync(gitBin, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`);
  return (result.stdout ?? "").trim();
}

if (isMain(import.meta.url, process.argv[1])) {
  try {
    main({ argv: process.argv.slice(2), stdout: process.stdout });
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

function isMain(url, entry) {
  try { return realpathSync(fileURLToPath(url)) === realpathSync(entry); } catch { return false; }
}
