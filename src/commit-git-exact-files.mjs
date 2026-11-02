import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const defaultGit = "/usr/bin/git";

const DECOMMISSION_COMPOUND_PATTERN = /\b([A-Za-z][\w]*(?:-[A-Za-z][\w]*)*)-decommission(?:ed|ing)?\b/giu;
const DECOMMISSION_PHRASE_PATTERN = /(?<!-)\bdecommission(?:ed|ing)?\s+(?:the\s+|an?\s+)?["'`]?([A-Za-z][\w./-]*)/giu;

/** Named targets a commit message claims to decommission/remove, from either "X-decommission" or "decommission the X" phrasing. */
function decommissionClaimTargets(message) {
  const targets = new Set();
  for (const match of message.matchAll(DECOMMISSION_COMPOUND_PATTERN)) targets.add(match[1]);
  for (const match of message.matchAll(DECOMMISSION_PHRASE_PATTERN)) targets.add(match[1]);
  return [...targets];
}

/**
 * Refuses a commit message that claims to decommission/remove a named target when no requested path
 * actually names that target — a self-reported "X decommissioned" in prose is not evidence X was
 * touched. Founder-ruled 2026-09-11 after a commit titled "...land accumulated FAE-decommission
 * fixes" landed touching zero FAE-related paths, while the actual FAE package/keywords/references
 * survived untouched for weeks across many sessions each believing prior sessions' own claims.
 */
function assertDecommissionClaimIsBacked(message, paths) {
  const targets = decommissionClaimTargets(message);
  if (targets.length === 0) return;
  const haystack = paths.join("\n").toLowerCase();
  const unbacked = targets.filter((target) => !haystack.includes(target.toLowerCase()));
  if (unbacked.length > 0) {
    throw new Error(
      `commit message claims decommissioning ${unbacked.map((target) => `'${target}'`).join(", ")} but no committed path names it — ` +
        "a decommission/removal claim must be backed by paths that actually touch the named target, not a self-report. " +
        "Include the paths that actually remove/rename it, or drop the decommission claim from the message.",
    );
  }
}

/**
 * Creates a commit from complete literal file endpoints and reconciles only those endpoints in the real index after ref installation.
 *
 * Every Git call that needs to know about the requested endpoints either passes them over stdin
 * (`git add ... --pathspec-from-file=- --pathspec-file-nul`, `update-index --stdin`) or reads a full,
 * unfiltered dump and filters it in JS — never as trailing pathspec arguments. A literal-endpoint
 * commit exists to be exact about *what* is committed regardless of *how many* paths that takes; an
 * implementation that silently falls over past a few thousand paths (the OS argv-size ceiling,
 * `ARG_MAX`) contradicts that purpose, so no call site here is sized by argument-list length.
 * @param {{repository?: string, paths: string[], message: string, gitBin?: string, beforeInstall?: (candidate: {head: string, parent: string, paths: string[]}) => void, dryRun?: boolean}} options Exact-file commit options.
 * @returns {{repository: string, paths: string[], message: string, committed: boolean, head?: string, parent: string, committedPaths?: string[], reason?: string, candidate?: string, witnessRef?: string, indexReconciled?: boolean, postCommit?: {ran: boolean, success: boolean, output: string}}} Commit result or an uninstalled candidate witness.
 * @throws {TypeError|Error} When inputs, repository state, hooks, signing, or file endpoints are unsafe.
 */
export function commitGitExactFiles({ repository = process.cwd(), paths, message, gitBin = defaultGit, beforeInstall, dryRun = false } = {}) {
  validateOptions(paths, message, beforeInstall);
  assertDecommissionClaimIsBacked(message, paths);
  const root = runGit(gitBin, resolve(repository), ["rev-parse", "--show-toplevel"]).trim();
  const requestedPaths = [...new Set(paths.map(normalizeLiteralPath))];
  const requestedSet = new Set(requestedPaths);
  rejectUnsupportedPolicies(gitBin, root);
  rejectUnsafeRepositoryState(gitBin, root);
  const headTrackedPaths = bulkPathSet(gitBin, root, ["ls-tree", "-z", "-r", "--full-tree", "HEAD"]);
  for (const path of requestedPaths) validateEndpoint(root, path, headTrackedPaths);

  const parent = runGit(gitBin, root, ["rev-parse", "HEAD"]).trim();
  if (dryRun) return Object.freeze({ repository: root, paths: requestedPaths, message, dryRun: true, committed: false, parent, reason: "dry-run" });
  const ref = symbolicHead(gitBin, root);
  const indexBefore = runGit(gitBin, root, ["ls-files", "--stage", "-z"]);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "commit-git-exact-files-"));
  const temporaryIndex = join(temporaryDirectory, "index");
  const environment = { GIT_INDEX_FILE: temporaryIndex, GIT_LITERAL_PATHSPECS: "1" };
  const forceAddPaths = trackedEndpoints(gitBin, root, requestedPaths, requestedSet, headTrackedPaths);
  try {
    runGit(gitBin, root, ["read-tree", parent], environment);
    addCandidateEndpoints(gitBin, root, requestedPaths, forceAddPaths, environment);
    const committedPaths = splitNull(runGit(gitBin, root, ["diff-index", "--cached", "--name-only", "-z", parent], environment));
    if (committedPaths.length === 0) return Object.freeze({ repository: root, paths: requestedPaths, message, committed: false, parent, reason: "nothing-staged" });
    assertExactPaths(requestedPaths, committedPaths);
    const indexEntries = filterNulEntriesToPaths(runGit(gitBin, root, ["ls-files", "--stage", "-z"], environment), requestedSet);
    const tree = runGit(gitBin, root, ["write-tree"], environment).trim();
    assertExactPaths(requestedPaths, splitNull(runGit(gitBin, root, ["diff-tree", "--no-commit-id", "-r", "--name-only", "-z", parent, tree], environment)));
    assertTreeMatchesIndex(gitBin, root, tree, indexEntries);
    const candidate = runGit(gitBin, root, ["commit-tree", tree, "-p", parent], environment, message).trim();
    const witnessRef = `refs/commit-git-exact-files/witness/${candidate}`;
    runGit(gitBin, root, ["update-ref", witnessRef, candidate]);
    const reconciliation = prepareIndexReconciliation(gitBin, root, requestedPaths, requestedSet, indexBefore, indexEntries);
    try {
      beforeInstall?.(Object.freeze({ head: candidate, parent, paths: committedPaths }));
      if (!selectedWorktreeMatchesCandidate(gitBin, root, requestedPaths, requestedSet, forceAddPaths, parent, temporaryIndex, indexEntries)) return Object.freeze({ repository: root, paths: requestedPaths, message, committed: false, parent, committedPaths, reason: "selected-worktree-changed", candidate, witnessRef, indexReconciled: false });
      const installed = tryInstall(gitBin, root, ref, candidate, parent);
      if (!installed) return Object.freeze({ repository: root, paths: requestedPaths, message, committed: false, parent, committedPaths, reason: "head-advanced", candidate, witnessRef, indexReconciled: false });
      installIndexReconciliation(gitBin, root, reconciliation, indexBefore);
      runGit(gitBin, root, ["update-ref", "-d", witnessRef, candidate]);
      return Object.freeze({ repository: root, paths: requestedPaths, message, committed: true, parent, head: candidate, committedPaths, indexReconciled: true, postCommit: runPostCommitHook(gitBin, root) });
    } finally {
      discardIndexReconciliation(reconciliation);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateOptions(paths, message, beforeInstall) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || path.length === 0)) throw new TypeError("at least one path is required");
  if (typeof message !== "string" || message.length === 0) throw new TypeError("message is required");
  if (beforeInstall !== undefined && typeof beforeInstall !== "function") throw new TypeError("beforeInstall must be a function");
}

function normalizeLiteralPath(path) {
  if (isAbsolute(path) || path === "." || path.startsWith("./") || path.split("/").includes("..") || /[\n\t]/u.test(path)) throw new TypeError(`path must be a literal repository-relative file without control characters: ${path}`);
  return path;
}

function validateEndpoint(root, path, headTrackedPaths) {
  let cursor = root;
  for (const segment of path.split("/").slice(0, -1)) {
    if (segment === ".git") throw new Error(`Git metadata endpoints are not supported: ${path}`);
    cursor = join(cursor, segment);
    const entry = lstatOrUndefined(cursor);
    if (entry?.isSymbolicLink()) throw new Error(`symlink directory endpoints are not supported: ${path}`);
    if (existsSync(join(cursor, ".git"))) throw new Error(`nested repository endpoints are not supported: ${path}`);
  }
  const endpoint = join(root, path);
  if (path === ".git") throw new Error(`Git metadata endpoints are not supported: ${path}`);
  const entry = lstatOrUndefined(endpoint);
  if (entry?.isDirectory()) throw new TypeError(`directories are not file endpoints: ${path}`);
  if (entry === undefined && !headTrackedPaths.has(path)) {
    throw new Error(`file endpoint does not exist and is not tracked: ${path}`);
  }
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function rejectUnsupportedPolicies(gitBin, root) {
  if (runGitOptional(gitBin, root, ["config", "--bool", "commit.gpgSign"]).trim() === "true") throw new Error("configured commit signing is unsupported by exact-file plumbing");
  const hooksDirectory = configuredHooksDirectory(gitBin, root);
  if (existsSync(hooksDirectory) && ["pre-commit", "prepare-commit-msg", "commit-msg"].some((name) => executableHookExists(hooksDirectory, name))) throw new Error("configured pre-commit or commit-message hooks are unsupported by exact-file plumbing");
}

function configuredHooksDirectory(gitBin, root) {
  const configured = runGitOptional(gitBin, root, ["config", "--path", "--get", "core.hooksPath"]).trim();
  return configured === "" ? runGit(gitBin, root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]).trim() : (isAbsolute(configured) ? configured : resolve(root, configured));
}

function executableHookExists(hooksDirectory, name) {
  const hook = join(hooksDirectory, name);
  return existsSync(hook) && (lstatSync(hook).mode & 0o111) !== 0;
}

function runPostCommitHook(gitBin, root) {
  const ran = executableHookExists(configuredHooksDirectory(gitBin, root), "post-commit");
  if (!ran) return Object.freeze({ ran: false, success: true, output: "" });
  const result = spawnSync(gitBin, ["hook", "run", "--ignore-missing", "post-commit"], { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  return Object.freeze({ ran: true, success: result.status === 0, output: (result.stdout || result.stderr || "").trim() });
}

function rejectUnsafeRepositoryState(gitBin, root) {
  const gitDirectory = runGit(gitBin, root, ["rev-parse", "--path-format=absolute", "--git-dir"]).trim();
  if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((name) => existsSync(join(gitDirectory, name)))) throw new Error("merge, cherry-pick, revert, and rebase contexts are unsupported by exact-file plumbing");
  if (splitNull(runGit(gitBin, root, ["ls-files", "-u", "-z"])).length > 0) throw new Error("unmerged index entries are unsupported by exact-file plumbing");
}

function symbolicHead(gitBin, root) {
  const ref = runGitOptional(gitBin, root, ["symbolic-ref", "-q", "HEAD"]).trim();
  return ref === "" ? "HEAD" : ref;
}

function assertExactPaths(requestedPaths, changedPaths) {
  const requested = [...requestedPaths].sort();
  const changed = [...changedPaths].sort();
  if (requested.length !== changed.length || requested.some((path, index) => path !== changed[index])) throw new Error(`candidate changed paths differ from requested endpoints: ${changed.join(", ")}`);
}

function assertTreeMatchesIndex(gitBin, root, tree, indexEntries) {
  const expected = new Map(splitNull(indexEntries).map(parseIndexEntry).map((entry) => [entry.path, `${entry.mode} ${entry.object}`]));
  const actual = new Map(
    splitNull(runGit(gitBin, root, ["ls-tree", "-z", "-r", "--full-tree", tree]))
      .map(parseTreeEntry)
      .filter((entry) => expected.has(entry.path))
      .map((entry) => [entry.path, `${entry.mode} ${entry.object}`]),
  );
  for (const [path, value] of expected) if (actual.get(path) !== value) throw new Error(`candidate tree differs from selected index entry: ${path}`);
}

function parseIndexEntry(entry) {
  const match = /^(\d+) ([0-9a-f]{40,64}) \d+\t(.+)$/u.exec(entry);
  if (!match) throw new Error("could not parse Git index entry");
  return { mode: match[1], object: match[2], path: match[3] };
}

function parseTreeEntry(entry) {
  const match = /^(\d+) \w+ ([0-9a-f]{40,64})\t(.+)$/u.exec(entry);
  if (!match) throw new Error("could not parse Git tree entry");
  return { mode: match[1], object: match[2], path: match[3] };
}

function tryInstall(gitBin, root, ref, candidate, parent) {
  if (symbolicHead(gitBin, root) !== ref || runGit(gitBin, root, ["rev-parse", "HEAD"]).trim() !== parent) return false;
  const result = spawnSync(gitBin, ["update-ref", ref, candidate, parent], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (runGitOptional(gitBin, root, ["rev-parse", ref]).trim() !== parent) return false;
  throw new Error(`git update-ref failed in ${root}: ${(result.stderr || result.stdout).trim()}`);
}

function prepareIndexReconciliation(gitBin, root, paths, requestedSet, before, candidateEntries) {
  const index = runGit(gitBin, root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const lock = `${index}.lock`;
  let descriptor;
  let acquiredIdentity;
  try {
    descriptor = openSync(lock, "wx");
    acquiredIdentity = lockIdentity(lock);
    writeFileSync(descriptor, readFileSync(index));
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      if (sameLockIdentity(lock, acquiredIdentity)) rmSync(lock, { force: true });
    }
    throw error;
  }
  let ownedIdentity = lockIdentity(lock);
  try {
    const environment = { GIT_INDEX_FILE: lock, GIT_LITERAL_PATHSPECS: "1" };
    runGit(gitBin, root, ["update-index", "--force-remove", "-z", "--stdin"], environment, `${paths.join("\0")}\0`);
    ownedIdentity = lockIdentity(lock);
    runGit(gitBin, root, ["update-index", "-z", "--index-info"], environment, candidateEntries);
    ownedIdentity = lockIdentity(lock);
    const reconciledEntries = filterNulEntriesToPaths(runGit(gitBin, root, ["ls-files", "--stage", "-z"], environment), requestedSet);
    if (reconciledEntries !== candidateEntries) throw new Error("selected worktree contents changed before index reconciliation");
    if (indexEntriesExcept(runGit(gitBin, root, ["ls-files", "--stage", "-z"]), paths) !== indexEntriesExcept(runGit(gitBin, root, ["ls-files", "--stage", "-z"] , environment), paths)) {
      throw new Error("selected index reconciliation would change an outside tuple");
    }
    if (runGit(gitBin, root, ["ls-files", "--stage", "-z"]) !== before) throw new Error("the real index changed before reconciliation lock acquisition");
    return { index, lock, lockIdentity: ownedIdentity, owned: true };
  } catch (error) {
    if (sameLockIdentity(lock, ownedIdentity)) rmSync(lock, { force: true });
    throw error;
  }
}

function installIndexReconciliation(gitBin, root, reconciliation, before) {
  if (runGit(gitBin, root, ["ls-files", "--stage", "-z"]) !== before) {
    discardIndexReconciliation(reconciliation);
    throw new Error("the real index changed while reconciliation was locked");
  }
  renameSync(reconciliation.lock, reconciliation.index);
  reconciliation.owned = false;
}

function discardIndexReconciliation(reconciliation) {
  if (reconciliation.owned && sameLockIdentity(reconciliation.lock, reconciliation.lockIdentity)) rmSync(reconciliation.lock, { force: true });
  reconciliation.owned = false;
}

function lockIdentity(path) {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}`;
}

function sameLockIdentity(path, identity) {
  try {
    return lockIdentity(path) === identity;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function selectedWorktreeMatchesCandidate(gitBin, root, paths, requestedSet, forceAddPaths, parent, index, candidateEntries) {
  const environment = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" };
  runGit(gitBin, root, ["read-tree", parent], environment);
  addCandidateEndpoints(gitBin, root, paths, forceAddPaths, environment);
  return filterNulEntriesToPaths(runGit(gitBin, root, ["ls-files", "--stage", "-z"], environment), requestedSet) === candidateEntries;
}

function trackedEndpoints(gitBin, root, paths, requestedSet, headTrackedPaths) {
  const indexTracked = new Set(
    splitNull(runGit(gitBin, root, ["ls-files", "--stage", "-z"]))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1))
      .filter((path) => requestedSet.has(path)),
  );
  return Object.freeze(paths.filter((path) => indexTracked.has(path) || headTrackedPaths.has(path)));
}

/** Reads every entry a bulk, unfiltered `-z` Git listing produced, as a Set of its trailing tab-separated path. */
function bulkPathSet(gitBin, root, args) {
  return new Set(splitNull(runGit(gitBin, root, args)).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
}

/**
 * Keeps only the NUL-terminated entries of a bulk `-z` Git listing whose trailing tab-separated path is
 * in `pathSet`, in the listing's original (path-sorted) order — byte-identical to what the same Git
 * subcommand would have produced had it been asked to filter by that exact pathspec list, since Git
 * always emits `ls-files`/`ls-tree` output in path order regardless of pathspec argument order.
 */
function filterNulEntriesToPaths(entries, pathSet) {
  const parts = entries.split("\0");
  const trailing = parts.pop() ?? "";
  const kept = parts.filter((entry) => pathSet.has(entry.slice(entry.indexOf("\t") + 1)));
  return kept.length === 0 ? trailing : `${kept.join("\0")}\0${trailing}`;
}

function addCandidateEndpoints(gitBin, root, paths, forceAddPaths, environment) {
  const forced = new Set(forceAddPaths);
  const ordinary = paths.filter((path) => !forced.has(path));
  if (ordinary.length > 0) runGitWithPathspecStdin(gitBin, root, ["add", "-A"], ordinary, environment);
  if (forceAddPaths.length > 0) runGitWithPathspecStdin(gitBin, root, ["add", "-f", "-A"], forceAddPaths, environment);
}

/** Runs a Git subcommand over an arbitrarily long path list via stdin (`--pathspec-from-file=- --pathspec-file-nul`) instead of trailing argv, so no call here is bounded by the OS argv-size limit. */
function runGitWithPathspecStdin(gitBin, root, args, paths, environment) {
  runGit(gitBin, root, [...args, "--pathspec-from-file=-", "--pathspec-file-nul"], environment, `${paths.join("\0")}\0`);
}

function indexEntriesExcept(entries, paths) {
  const selected = new Set(paths);
  return splitNull(entries).filter((entry) => !selected.has(entry.slice(entry.indexOf("\t") + 1))).join("\0");
}

function splitNull(text) {
  return text.split("\0").filter(Boolean);
}

function runGitOptional(gitBin, cwd, args) {
  const result = spawnSync(gitBin, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout ?? "" : "";
}

function runGit(gitBin, cwd, args, environment = {}, input) {
  const result = spawnSync(gitBin, args, { cwd, encoding: "utf8", env: { ...process.env, ...environment }, input, maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout ?? "";
}
