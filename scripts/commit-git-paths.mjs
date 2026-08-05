#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultGit = resolve(scriptDirectory, "../../../scripts/git-services");

export function commitGitPaths({ repository = process.cwd(), paths, message, dryRun = false, gitBin = process.env.GIT_SERVICES_BIN ?? defaultGit } = {}) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new TypeError("at least one path is required");
  }
  if (typeof message !== "string" || message.length === 0) throw new TypeError("message is required");
  const cwd = resolve(repository);
  const root = runGit(gitBin, cwd, ["rev-parse", "--show-toplevel"]).trim();
  const requestedPaths = [...new Set(paths.map(normalizePath))];
  const plan = { repository: root, paths: requestedPaths, message, dryRun };
  if (dryRun) return Object.freeze(plan);

  const alreadyStaged = splitNull(runGit(gitBin, root, ["diff", "--cached", "--name-only", "-z"]));
  const unexpected = alreadyStaged.filter((path) => !requestedPaths.some((requested) => path === requested || path.startsWith(`${requested}/`)));
  if (unexpected.length > 0) throw new Error(`refusing to include already-staged paths: ${unexpected.join(", ")}`);
  runGit(gitBin, root, ["add", "-A", "--", ...requestedPaths]);
  const selected = splitNull(runGit(gitBin, root, ["diff", "--cached", "--name-only", "-z", "--", ...requestedPaths]));
  if (selected.length === 0) return Object.freeze({ ...plan, committed: false, reason: "nothing-staged" });

  runGit(gitBin, root, ["commit", "-m", message, "--", ...requestedPaths]);
  const head = runGit(gitBin, root, ["rev-parse", "HEAD"]).trim();
  return Object.freeze({ ...plan, committed: true, head, committedPaths: selected });
}

function normalizePath(path) {
  if (path.startsWith("/") || path.split(/[\\/]+/u).includes("..")) throw new TypeError(`path must be repository-relative: ${path}`);
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function splitNull(text) {
  return text.split("\0").filter(Boolean);
}

function runGit(gitBin, cwd, args) {
  const result = spawnSync(gitBin, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout ?? "";
}

function parseArgs(argv) {
  const options = { paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repository") options.repository = argv[++index];
    else if (argument === "--path") options.paths.push(argv[++index]);
    else if (argument === "--message") options.message = argv[++index];
    else if (argument === "--git-bin") options.gitBin = argv[++index];
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--help") options.help = true;
    else throw new TypeError(`unknown argument: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("usage: commit-git-paths --repository <path> --path <path> [--path <path>...] --message <message> [--dry-run] [--git-bin <path>]\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(commitGitPaths(options))}\n`);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
