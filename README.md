# dwl-update

A weekly merge of upstream [dwl](https://codeberg.org/dwl/dwl) into a fork of
it, as a reusable GitHub Actions workflow: the fork-tracking sibling of
[npm-update](https://github.com/mikelward/npm-update),
[gradle-update](https://github.com/mikelward/gradle-update) and
[rust-update](https://github.com/mikelward/rust-update). Its consumer is
[tidewm](https://github.com/mikelward/tidewm).

## What it does

Once a week (the consumer owns the cron), the workflow fetches upstream's
`main` and:

- **Nothing new:** the run ends green with nothing to publish.
- **A clean merge:** it runs `git merge --no-edit --no-ff upstream/main` on
  the default branch, builds the result (`make`, then the Xwayland build),
  and opens or updates one pull request, **Merge upstream dwl**, from the
  `dwl-update` branch. The body lists the upstream commits it brings and the
  checks it ran. It's assigned to the repository owner, and auto-merge is
  armed when the checks passed and the ruleset requires branches to be up to
  date. A failed check titles the PR **Merge upstream dwl — CHECKS FAILING**
  and leaves auto-merge off: push the fixes to the branch.
- **A conflict:** nothing is committed or published. It opens one issue,
  **Merge upstream dwl: conflicts**, naming the conflicting files and the
  upstream commits, updates it each week while the conflict lasts, and fails
  the run. Resolve it by hand (the issue says how) in a PR that closes it; the
  next clean run also closes it.

The fork keeps upstream by **merging**, never rebasing, so upstream's commits
land under their own hashes and each week only reconciles what is new. Merge
the PR with a **merge commit**: a rebase or a squash would drop the merge and
next week's would start over. Auto-merge uses a merge commit, so the
consumer must allow them.

The `dwl-update` branch is replaced each week while it holds only this
workflow's merge. Once someone pushes to it, the workflow leaves it alone and
the run fails, saying so, until the PR is merged or closed or the branch is
deleted.

## Trust model

The siblings' split. Building the merge runs code nobody has reviewed yet, so:

- the **update job** holds a read-only token, records the merge commit's hash
  before anything builds, and hands the commit over as a git bundle with the
  checks' record, fingerprinted the same way;
- the **publish job**, on a fresh runner that builds nothing, checks the
  bundle holds that commit, that its parents are the base and a commit on
  upstream's branch (fetched afresh), and that its tree is git's own merge of
  the two (`git merge-tree`). It derives the pass/fail verdict from the
  verified record, not from anything the update job reported about itself,
  and is the only job that can push;
- the **conflict job** re-derives the conflicting files itself and writes
  the issue with `GITHUB_TOKEN`; it needs no credential.

Read the check results as evidence, not proof: the merge itself is what's
verified.

## Consuming it

`.github/workflows/dwl-update.yml` in the fork:

```yaml
name: dwl update

on:
  schedule:
    - cron: '43 5 * * 6'   # Saturdays, off the top of the hour
  workflow_dispatch:

permissions: {}

jobs:
  dwl-update:
    uses: mikelward/dwl-update/.github/workflows/dwl-update.yml@main
    permissions:
      contents: write
      pull-requests: write
      issues: write
    secrets: inherit
```

The called workflow downscopes those per job; the job that builds anything
only ever sees `contents: read`.

`secrets: inherit` is how an environment secret reaches a called workflow.
Allow zizmor's `secrets-inherit` finding for that file in the fork's
`.github/zizmor.yml`.

Inputs, all optional:

- `upstream-url` (default `https://codeberg.org/dwl/dwl.git`) and
  `upstream-branch` (default `main`).
- `container` (default `debian:testing`): the image the update job builds
  in, since dwl's `main` needs wlroots 0.20, which Ubuntu's runners lack.
  Empty runs on the runner itself.
- `setup`: a script that installs what the checks need, run as root before
  the checkout. It must install `git` and `ca-certificates`. The default
  installs tidewm's build dependencies from Debian.
- `checks`: commands, one per line, run at the repository root. The default
  is `make`, then `make -B XWAYLAND=-DXWAYLAND XLIBS="xcb xcb-icccm"` (`-B`
  because the Makefile doesn't depend on `XWAYLAND`).
- `environment` (default `dwl-update`): the environment the publish job reads
  its credential from.

## The credential

The publish job pushes and opens the PR as `DWL_UPDATE_PAT` (a fine-grained
personal access token with Contents and Pull requests read and write on the
fork), or as a GitHub App, `DWL_UPDATE_APP_ID` plus
`DWL_UPDATE_APP_PRIVATE_KEY`, with the same two permissions; the PAT wins if
both are set. Either opens the PR as a collaborator, so the fork's
`pull_request` CI runs on it. Without one it falls back to `GITHUB_TOKEN`,
whose PRs' CI waits for a manual approval.

Store it in the fork's `dwl-update` environment, not as a repository secret:
`secrets: inherit` hands a repository secret to every job, the untrusted
update job included, while an environment secret reaches only the job that
declares the environment. `repo secrets` (mikelward/repo) sets it up there.

If upstream ever changes `.github/workflows/`, pushing the merge needs the
Workflows permission too; dwl has no workflows today.

## Cost and reliability

- **Cost:** none. Public-repo Actions minutes are free; a run is a few
  minutes a week (most of it `apt-get` and two builds).
- **Codeberg:** the upstream fetch is the one dependency outside GitHub. An
  outage fails that week's run; the next one catches up.
- **Debian testing:** it moves, so a build can break with no change upstream
  or in the fork. That shows as **CHECKS FAILING**, and the fork's own CI
  breaks the same way.
- **Races:** if the default branch moves while the checks run, publishing
  stops and asks for a re-run rather than open a PR built on a stale base.

## Testing

```
node --test *.test.js
```

No install step. Besides the shape of the workflow, the suite runs its merge,
checks, handoff-verification and conflict steps, extracted from the real
file, against scratch git repositories.
