# TODO

## Setup

- [ ] Scaffold `main` with `repo setup`, then commit the workflow, tests and
      docs on a branch.
- [ ] Create tidewm's `dwl-update` environment and set `DWL_UPDATE_PAT`
      there (`repo secrets`, once mikelward/repo#108 adds `dwl-update` to
      `BATCH_HUBS`).
- [ ] Allow merge commits on tidewm, so auto-merge can use one.
- [ ] Merge tidewm's caller, then run it by hand. The first run will
      conflict (`client.h`, `dwl.c`), so it should file the issue; resolve
      that merge by hand.

## Later

- [ ] Run `make test` in the update job too, as tidewm's plan describes. It
      needs `python3`, `xwayland`, `wtype` and `wlr-randr` in `setup`. The
      PR's own CI already runs it, so it's belt and braces.
- [ ] Pin `actions/create-github-app-token` by hash, as the siblings plan.

## Decisions needing review

Recorded at creation (2026-11-09):

- **A conflict files an issue and fails the run.** Nothing conflicted is
  ever committed. rust-update fails loudly on what it can't resolve; the
  issue adds the file list and the steps to resolve it. One issue, updated
  weekly, closed by the next clean run.
- **One branch, `dwl-update`, replaced weekly** with a lease, but only while
  its tip is this workflow's own merge. The siblings' dated branches
  would open a new PR each week beside an unmerged one.
- **Auto-merge uses a merge commit,** not the siblings' rebase, which would
  flatten the merge.
- **Builds in a container (`debian:testing`)** chosen by input, with the
  dependencies as a `setup` script, because wlroots 0.20 isn't on Ubuntu's
  runners.
- **Dropped from rust-update:** the legacy `token`/`app-id`/`app-private-key`
  workflow_call secrets (no legacy callers), the `ci-workflow` dispatch
  (the PAT makes the PR's own CI run), `commit-prefix` (one consumer), the
  dated-branch adoption logic, and the tree check (only the commit is handed
  over, and its hash covers its content).
