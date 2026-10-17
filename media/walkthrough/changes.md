# Changes

The Changes view covers the repositories of the active task: its folder and every repository its
agent changed, sibling repositories and worktrees included.

- **MR delta** (default): what each branch changes against its base branch, from the merge base
  to the working tree, untracked files included. That is what reviewers will see.
- **Uncommitted changes**: the working tree against HEAD.

The base branch is the remote's default branch. If your merge requests target another one, set
`aiTasks.baseBranch`, e.g. `origin/develop`.
