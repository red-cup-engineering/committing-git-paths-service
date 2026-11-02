# committing-git-paths-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Commits only explicitly named, literal repository-relative file endpoints in a
Git repository. It uses an isolated candidate index, so unrelated staged index
tuples and unrelated unstaged bytes remain untouched. A rename requires both
the old and new endpoints.

## Usage

```sh
commit-git-paths --repository /path/to/repo --path src/foo.js --path src/bar.js --message "Update foo"
```

Options:

- `--repository <path>` — repository to operate in (default: current directory)
- `--path <literal-file>` — complete file endpoint to commit; repeatable, at least one required
- `--paths-from <file>` — read literal paths from a file, one per line, so a commit is not limited by the argument list size
- `--across-repositories` — group the paths by their owning Git repository (nested submodules included) and commit each group; without it, nested-repository endpoints are refused
- `--message <message>` — commit message (required)
- `--dry-run` — validate repository, policies, and endpoints, then print a no-mutation plan
- `--git-bin <path>` — path to Git (default: `/usr/bin/git`)
- `--exact-files` — accepted for compatibility; literal-file isolation is always used

The operator refuses directories, paths through symlink directories, Git
metadata, nested repositories, unsafe merge/rebase state, configured
pre-commit/commit-message hooks, and signing. It refuses to install if the
selected worktree changes or `HEAD` advances. A post-commit hook runs after
successful installation and reports its result without undoing the commit.

As a library:

```js
import { commitGitPaths } from "@red-cup-engineering/committing-git-paths-service";

const result = commitGitPaths({
  repository: "/path/to/repo",
  paths: ["src/foo.js"],
  message: "Update foo",
});
```

`commitGitPaths` and `commitGitExactFiles` are the same operation. It returns
`committed: false` with `reason: "nothing-staged"`, `"dry-run"`,
`"selected-worktree-changed"`, or `"head-advanced"` when it has not moved the
branch ref.

## Test

```sh
npm test
```

## Staged work outside the selection

An earlier version refused to commit while unrelated paths were staged
(`already-staged paths: ...`). The isolated candidate index replaces that
refusal: unrelated staged tuples are left staged and uncommitted.
