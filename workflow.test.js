// Tests for .github/workflows/dwl-update.yml. This repository ships no YAML
// parser on purpose, so the shape is asserted by regex over the raw text, and
// the shell steps that decide what gets published are extracted from the real
// file and run against scratch git repositories: a fork, its upstream, and a
// fresh clone standing in for the publish runner.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(new URL("./.github/workflows/dwl-update.yml", import.meta.url), "utf8");

// A job runs from its "  <name>:" line to the next line at the same indent.
function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job "${name}" not found`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\S/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// The `run: |` script of the step with this name, dedented.
function stepScript(name) {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `step "${name}" not found`);
  const nextStep = workflow.indexOf("\n      - ", start + 1);
  const step = workflow.slice(start, nextStep === -1 ? undefined : nextStep);
  const run = step.indexOf("run: |\n");
  assert.notEqual(run, -1, `step "${name}" has no run block`);
  const lines = [];
  for (const line of step.slice(run + "run: |\n".length).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

const jobs = { update: jobBlock("update"), conflict: jobBlock("conflict"), publish: jobBlock("publish") };

describe("the trust split", () => {
  test("the workflow declares an explicit empty top-level permissions block", () => {
    const beforeJobs = workflow.slice(0, workflow.indexOf("\njobs:"));
    assert.match(beforeJobs, /^permissions: \{\}$/m);
  });

  test("only the publish job declares the environment, defaulting to dwl-update", () => {
    assert.match(workflow, /^      environment:\n        description: >-[^]*?\n        type: string\n        default: dwl-update\n/m);
    const environments = [...workflow.matchAll(/^    environment: (.*)$/gm)].map((m) => m[1]);
    assert.deepEqual(environments, ["${{ inputs.environment }}"]);
    assert.match(jobs.publish, /^    environment: \$\{\{ inputs\.environment \}\}$/m);
    assert.doesNotMatch(jobs.update, /environment:/);
    assert.doesNotMatch(jobs.conflict, /environment:/);
  });

  test("no job but publish names a secret, and none declares workflow_call secrets", () => {
    // Callers pass `secrets: inherit`; the credential lives in the
    // environment, which only publish declares. A `secrets:` block under
    // workflow_call would invite the legacy pass-by-name route, which
    // reaches every job's runner.
    assert.doesNotMatch(jobs.update, /secrets\./);
    assert.doesNotMatch(jobs.conflict, /secrets\./);
    assert.doesNotMatch(workflow.slice(0, workflow.indexOf("\njobs:")), /^    secrets:/m);
  });

  test("the update job holds only a read-only token and drops it from .git/config", () => {
    assert.match(jobs.update, /\n    permissions:\n      contents: read\n    outputs:/);
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@[^\n]*\n(?:[^\n]*\n)*?\s*persist-credentials: (\S+)/g)];
    assert.equal(checkouts.length, 3, "expected one checkout per job");
    for (const m of checkouts) assert.equal(m[1], "false");
  });

  test("the conflict job writes issues with GITHUB_TOKEN alone", () => {
    assert.match(jobs.conflict, /\n    permissions:\n      contents: read\n      issues: write\n    steps:/);
    const tokens = [...jobs.conflict.matchAll(/GH_TOKEN: (.*)/g)].map((m) => m[1]);
    assert.deepEqual(tokens, ["${{ github.token }}"]);
  });

  test("the publish job reads the hub-named credential into env", () => {
    assert.match(jobs.publish, /PAT: \$\{\{ secrets\.DWL_UPDATE_PAT \}\}/);
    assert.match(jobs.publish, /APP_ID: \$\{\{ secrets\.DWL_UPDATE_APP_ID \}\}/);
    assert.match(jobs.publish, /APP_PRIVATE_KEY: \$\{\{ secrets\.DWL_UPDATE_APP_PRIVATE_KEY \}\}/);
  });

  test("a half-supplied App credential is refused through env, and only when no PAT is set", () => {
    assert.match(jobs.publish, /if: env\.PAT == '' && \(env\.APP_ID == ''\) != \(env\.APP_PRIVATE_KEY == ''\)/);
    assert.doesNotMatch(workflow, /if:[^\n]*secrets\./);
  });

  test("the App token is minted only without a PAT, scoped to contents and pull requests", () => {
    assert.match(jobs.publish, /if: env\.PAT == '' && env\.APP_ID != ''/);
    assert.match(
      jobs.publish,
      /uses: actions\/create-github-app-token@v2\s*\n\s*with:\s*\n\s*app-id: \$\{\{ env\.APP_ID \}\}\s*\n\s*private-key: \$\{\{ env\.APP_PRIVATE_KEY \}\}/,
    );
    assert.match(jobs.publish, /permission-contents: write\n\s*permission-pull-requests: write\n/);
  });

  test("every GH_TOKEN in publish prefers the PAT, then the App token, then github.token", () => {
    const tokens = [...jobs.publish.matchAll(/GH_TOKEN: (.*)/g)].map((m) => m[1]);
    assert.ok(tokens.length >= 2);
    for (const t of tokens) assert.equal(t, "${{ env.PAT || steps.app-token.outputs.token || github.token }}");
  });

  test("issue and ruleset calls in publish stay on GITHUB_TOKEN", () => {
    // The PAT and the App are asked for contents and pull requests only.
    assert.match(jobs.publish, /DEFAULT_TOKEN: \$\{\{ github\.token \}\}/);
    for (const m of jobs.publish.matchAll(/^.*gh (?:issue|api --paginate).*$/gm)) {
      assert.match(m[0], /GH_TOKEN="\$DEFAULT_TOKEN"/, `not on GITHUB_TOKEN: ${m[0].trim()}`);
    }
  });

  test("update-job outputs reach publish's scripts only through env", () => {
    // `${{ }}` expands into script text before bash runs.
    for (const name of ["Check the merge against the pre-build fingerprint", "Stop if the default branch moved while the checks ran", "Open the pull request"]) {
      assert.doesNotMatch(stepScript(name), /\$\{\{/, name);
    }
  });

  test("the merge's fingerprint is taken in the merge step, before the checks", () => {
    assert.match(jobs.update, /merge_sha: \$\{\{ steps\.merge\.outputs\.merge_sha \}\}/);
    assert.match(jobs.update, /checks_sha: \$\{\{ steps\.checks\.outputs\.checks_sha \}\}/);
    assert.doesNotMatch(workflow, /needs\.update\.outputs\.passed/);
    assert.match(jobs.publish, /PASSED: \$\{\{ steps\.verdict\.outputs\.passed \}\}/);
  });
});

describe("publishing", () => {
  test("auto-merge uses a merge commit, never a rebase or a squash", () => {
    // Either would drop the merge and rewrite upstream's hashes, and next
    // week's merge would start over.
    assert.match(jobs.publish, /gh pr merge --auto --merge --subject "\$title" --match-head-commit "\$MERGE_SHA" "\$pr"/);
    for (const m of workflow.matchAll(/^.*gh pr merge.*$/gm)) {
      assert.doesNotMatch(m[0], /--rebase|--squash/);
    }
  });

  test("auto-merge is armed only when the checks passed and the ruleset is strict", () => {
    assert.match(jobs.publish, /if test "\$PASSED" = 'true' && test "\$strict" = 'true'; then\n\s*if ! gh pr merge --auto/);
  });

  test("the strict-policy probe pipes --slurp into a separate jq", () => {
    assert.match(workflow, /strict=\$\(GH_TOKEN="\$DEFAULT_TOKEN" gh api --paginate --slurp [^\n]*\\\n\s*\| jq /);
    assert.doesNotMatch(workflow, /gh api[^\n]*--slurp[^\n]*--jq|gh api[^\n]*--jq[^\n]*--slurp/);
  });

  test("the branch is replaced only with a lease on what was there", () => {
    assert.match(jobs.publish, /BRANCH: dwl-update\n/);
    assert.match(jobs.publish, /git push --force-with-lease="refs\/heads\/\$BRANCH:\$existing" "\$remote" "\$MERGE_SHA:refs\/heads\/\$BRANCH"/);
    assert.equal([...workflow.matchAll(/git push /g)].length, 2);
  });

  test("a PAT- or App-opened PR gets a @codex review nudge", () => {
    assert.match(jobs.publish, /if test "\$nondefault_opened_pr" = 'true'; then\n\s*if ! gh pr comment "\$pr" --body '@codex review'; then/);
  });
});

function runTitle(passed) {
  const script = stepScript("Open the pull request");
  const start = script.indexOf("if test \"$PASSED\" != 'true'; then");
  const end = script.indexOf("\nfi\n", start);
  assert.ok(start !== -1 && end !== -1, "title block not found");
  return execFileSync("bash", ["-c", `set -euo pipefail\n${script.slice(start, end + 3)}\nprintf '%s' "$title"`], {
    encoding: "utf8",
    env: { ...process.env, PASSED: passed },
  });
}

test("the title names the merge, flags failing checks, and carries no date or hash", () => {
  assert.equal(runTitle("true"), "Merge upstream dwl");
  assert.equal(runTitle("false"), "Merge upstream dwl — CHECKS FAILING");
  assert.equal(runTitle(""), "Merge upstream dwl — CHECKS FAILING");
});

// ---- Scratch repositories -------------------------------------------------

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "dwl-update-test-"));
  const gitconfig = join(dir, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  const env = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    GITHUB_PATH: join(dir, "path"),
    GITHUB_ENV: join(dir, "envfile"),
  };
  for (const f of ["output", "summary", "path", "envfile"]) writeFileSync(join(dir, f), "");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const commit = (cwd, file, content, message) => {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", message);
  };
  const run = (cwd, script, extraEnv = {}) =>
    spawnSync("bash", ["-c", script], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
  const outputs = () =>
    Object.fromEntries(
      readFileSync(env.GITHUB_OUTPUT, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
    );
  return { dir, env, git, commit, run, outputs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// An upstream, a fork of it with one commit of its own, and upstream moving
// on: cleanly (a file the fork never touched) or not (a line the fork
// changed too), or not at all.
function forkAndUpstream(s, upstreamMoves) {
  const upstream = join(s.dir, "upstream");
  const fork = join(s.dir, "fork");
  mkdirSync(upstream);
  s.git(upstream, "init", "-q");
  s.commit(upstream, "dwl.c", "one\n", "Initial");
  s.commit(upstream, "client.h", "two\n", "Add client.h");
  s.git(s.dir, "clone", "-q", upstream, fork);
  s.commit(fork, "dwl.c", "one, forked\n", "Fork dwl.c");
  if (upstreamMoves === "clean") s.commit(upstream, "client.h", "two, upstream\n", "Change client.h");
  if (upstreamMoves === "conflict") {
    s.commit(upstream, "client.h", "two, upstream\n", "Change client.h");
    s.commit(upstream, "dwl.c", "one, upstream\n", "Change dwl.c");
  }
  return { upstream, fork, upstreamEnv: { UPSTREAM_URL: upstream, UPSTREAM_BRANCH: "main" } };
}

const mergeScript = stepScript("Merge upstream");

describe("the merge step", () => {
  test("finishes with nothing to publish when upstream has nothing new", () => {
    const s = sandbox();
    try {
      const { fork, upstreamEnv } = forkAndUpstream(s, "none");
      const r = s.run(fork, mergeScript, upstreamEnv);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(s.outputs().state, "none");
      assert.equal(s.outputs().merge_sha, undefined);
    } finally {
      s.cleanup();
    }
  });

  test("commits a merge of the base and upstream and bundles it", () => {
    const s = sandbox();
    try {
      const { fork, upstream, upstreamEnv } = forkAndUpstream(s, "clean");
      const base = s.git(fork, "rev-parse", "HEAD");
      const r = s.run(fork, mergeScript, upstreamEnv);
      assert.equal(r.status, 0, r.stderr);
      const out = s.outputs();
      assert.equal(out.state, "merged");
      assert.equal(out.base, base);
      assert.equal(out.upstream, s.git(upstream, "rev-parse", "HEAD"));
      assert.equal(out.merge_sha, s.git(fork, "rev-parse", "HEAD"));
      assert.equal(s.git(fork, "rev-parse", "HEAD^@"), `${base}\n${out.upstream}`);
      assert.equal(s.git(fork, "log", "-1", "--format=%an|%s"), "github-actions[bot]|Merge remote-tracking branch 'upstream/main'");
      assert.ok(existsSync(join(fork, ".dwl-update/merge.bundle")));
    } finally {
      s.cleanup();
    }
  });

  test("leaves a conflict uncommitted and the tree clean", () => {
    const s = sandbox();
    try {
      const { fork, upstreamEnv } = forkAndUpstream(s, "conflict");
      const base = s.git(fork, "rev-parse", "HEAD");
      const r = s.run(fork, mergeScript, upstreamEnv);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(s.outputs().state, "conflict");
      assert.equal(s.outputs().merge_sha, undefined);
      assert.equal(s.git(fork, "rev-parse", "HEAD"), base);
      assert.equal(s.git(fork, "status", "--porcelain"), "");
      assert.match(r.stdout, /dwl\.c/);
    } finally {
      s.cleanup();
    }
  });

  test("refuses a consumer that tracks the handoff directory", () => {
    const s = sandbox();
    try {
      const { fork, upstreamEnv } = forkAndUpstream(s, "clean");
      mkdirSync(join(fork, ".dwl-update"));
      s.commit(fork, ".dwl-update/x", "x\n", "Track it");
      const r = s.run(fork, mergeScript, upstreamEnv);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /tracks \.dwl-update/);
    } finally {
      s.cleanup();
    }
  });
});

const checksScript = stepScript("Run the checks");

describe("the checks step", () => {
  test("records every check, fingerprints the record, and empties the path and env files", () => {
    const s = sandbox();
    try {
      const work = join(s.dir, "work");
      mkdirSync(join(work, ".dwl-update"), { recursive: true });
      writeFileSync(s.env.GITHUB_PATH, "/planted\n");
      // The first check drains stdin: without the redirect it would swallow
      // the commands after it, which would never run or report.
      const r = s.run(work, checksScript, { CHECKS: "cat > /dev/null\nfalse\n\ntrue\n" });
      assert.equal(r.status, 0, r.stderr);
      const md = readFileSync(join(work, ".dwl-update/checks.md"), "utf8");
      assert.equal(md, "- ✅ `cat > /dev/null`\n- ❌ `false` (exit 1)\n- ✅ `true`\n");
      assert.equal(s.outputs().checks_sha, createHash("sha256").update(md).digest("hex"));
      assert.equal(readFileSync(s.env.GITHUB_PATH, "utf8"), "");
    } finally {
      s.cleanup();
    }
  });

  test("a check cannot write the step's outputs", () => {
    const s = sandbox();
    try {
      const work = join(s.dir, "work");
      mkdirSync(join(work, ".dwl-update"), { recursive: true });
      const r = s.run(work, checksScript, { CHECKS: 'echo checks_sha=forged >> "$GITHUB_OUTPUT"' });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(readFileSync(s.env.GITHUB_OUTPUT, "utf8"), /forged/);
    } finally {
      s.cleanup();
    }
  });
});

const verifyScript = stepScript("Check the merge against the pre-build fingerprint");

// Runs the merge and a check in the fork, then hands the result to a fresh
// clone at the base, as the publish job sees it. `tamper` runs in the fork
// after the merge and may return a replacement merge sha.
function publishCheck(s, { tamper } = {}) {
  const { fork, upstreamEnv } = forkAndUpstream(s, "clean");
  const fresh = join(s.dir, "publish");
  s.git(s.dir, "clone", "-q", fork, fresh);
  let r = s.run(fork, mergeScript, upstreamEnv);
  assert.equal(r.status, 0, r.stderr);
  r = s.run(fork, checksScript, { CHECKS: "true" });
  assert.equal(r.status, 0, r.stderr);
  const out = s.outputs();
  if (tamper) {
    const replaced = tamper(fork, out);
    if (replaced) out.merge_sha = replaced;
  }
  mkdirSync(join(fresh, ".dwl-update"));
  for (const f of ["merge.bundle", "checks.md"]) copyFileSync(join(fork, ".dwl-update", f), join(fresh, ".dwl-update", f));
  return s.run(fresh, verifyScript, {
    ...upstreamEnv,
    BASE: out.base,
    UPSTREAM: out.upstream,
    MERGE_SHA: out.merge_sha,
    CHECKS_SHA: out.checks_sha,
  });
}

describe("publish's check of the handoff", () => {
  test("accepts git's own merge, as recorded", () => {
    const s = sandbox();
    try {
      const r = publishCheck(s);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      s.cleanup();
    }
  });

  test("refuses a bundle whose commit isn't the recorded one", () => {
    const s = sandbox();
    try {
      const r = publishCheck(s, {
        tamper: (fork, out) => {
          s.commit(fork, "planted", "x\n", "Plant");
          s.git(fork, "bundle", "create", ".dwl-update/merge.bundle", "HEAD", `^${out.base}`);
        },
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /bundle does not hold the merge/);
    } finally {
      s.cleanup();
    }
  });

  test("refuses a merge whose tree isn't git's own, even with the right parents", () => {
    // A forged merge_sha cannot get past the parents and tree checks: the
    // only commit that passes is git's merge of the two.
    const s = sandbox();
    try {
      const r = publishCheck(s, {
        tamper: (fork, out) => {
          writeFileSync(join(fork, "planted"), "x\n");
          s.git(fork, "add", "planted");
          s.git(fork, "commit", "-q", "--amend", "--no-edit");
          s.git(fork, "bundle", "create", ".dwl-update/merge.bundle", "HEAD", `^${out.base}`);
          return s.git(fork, "rev-parse", "HEAD");
        },
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /not git's own merge/);
    } finally {
      s.cleanup();
    }
  });

  test("refuses a checks record changed after it was fingerprinted", () => {
    const s = sandbox();
    try {
      const r = publishCheck(s, {
        tamper: (fork) => writeFileSync(join(fork, ".dwl-update/checks.md"), "- ✅ `true`\n- ✅ `true`\n") && undefined,
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /checks\.md does not match/);
    } finally {
      s.cleanup();
    }
  });
});

const conflictScript = stepScript("File the conflict");

// A gh that records its arguments and answers like the API: no open issues,
// and a URL for a created one.
function stubGh(s) {
  const bin = join(s.dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash\necho "$*" >> "${join(s.dir, "gh.log")}"\nif test "$1 $2" = "issue create"; then echo https://github.com/o/r/issues/7; fi\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(s.dir, "gh.log"), "");
  return { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_REPOSITORY_OWNER: "o", DEFAULT_BRANCH: "main", TITLE: "Merge upstream dwl: conflicts" };
}

describe("the conflict job", () => {
  test("files one issue naming the conflicting files and the upstream commits, and fails the run", () => {
    const s = sandbox();
    try {
      const { fork, upstreamEnv } = forkAndUpstream(s, "conflict");
      const r = s.run(fork, conflictScript, { ...upstreamEnv, ...stubGh(s) });
      assert.equal(r.status, 1, r.stderr);
      const body = readFileSync(join(fork, "body.md"), "utf8");
      const files = body.split("## Conflicting files\n\n")[1].split("\n\n")[0];
      assert.equal(files, "- `dwl.c`");
      assert.match(body, /Change dwl\.c\n[0-9a-f]+ Change client\.h\n```/);
      assert.match(readFileSync(join(s.dir, "gh.log"), "utf8"), /^issue create --title Merge upstream dwl: conflicts --body-file body\.md$/m);
      assert.match(r.stdout, /::error::Upstream conflicts with main; see #7\./);
    } finally {
      s.cleanup();
    }
  });

  test("files nothing when the merge turns out clean", () => {
    const s = sandbox();
    try {
      const { fork, upstreamEnv } = forkAndUpstream(s, "clean");
      const r = s.run(fork, conflictScript, { ...upstreamEnv, ...stubGh(s) });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(s.dir, "gh.log"), "utf8"), "");
    } finally {
      s.cleanup();
    }
  });
});

// ---- The verdict, ported from rust-update ---------------------------------

function runVerdict(checks, checksMd) {
  const s = sandbox();
  try {
    writeFileSync(join(s.dir, "checks.md"), checksMd);
    const r = s.run(s.dir, `set -euo pipefail\n${stepScript("Derive the check verdict from checks.md")}`, { CHECKS: checks });
    assert.equal(r.status, 0, r.stderr);
    return s.outputs().passed;
  } finally {
    s.cleanup();
  }
}

describe("the derived verdict", () => {
  const checks = 'make\nmake -B XWAYLAND=-DXWAYLAND XLIBS="xcb xcb-icccm"';

  test("passes only a checks.md that exactly matches the configured checks, all green", () => {
    assert.equal(runVerdict(checks, '- ✅ `make`\n- ✅ `make -B XWAYLAND=-DXWAYLAND XLIBS="xcb xcb-icccm"`\n'), "true");
    assert.equal(runVerdict(checks, '- ✅ `make -B XWAYLAND=-DXWAYLAND XLIBS="xcb xcb-icccm"`\n- ✅ `make`'), "true");
    assert.equal(runVerdict("echo `date`", "- ✅ `echo `date``\n"), "true");
  });

  test("fails closed on every malformed, mismatched or failing checks.md", () => {
    const x = '`make -B XWAYLAND=-DXWAYLAND XLIBS="xcb xcb-icccm"`';
    for (const [content, label] of [
      [`- ✅ \`make\`\n- ❌ ${x} (exit 2)\n`, "a failure"],
      ["", "an empty record"],
      ["- ✅ `make`\n", "a missing check"],
      ["- ✅ `make`\n- ✅ `make`\n", "a duplicate standing in for a missing one"],
      [`- ✅ \`make\`\n- ✅ ${x}\n- ✅ \`true\`\n`, "an unconfigured check"],
      [`- ✅ \`make\`\n- ✅ ${x}\nAll checks passed!\n`, "a non-canonical line"],
      [`- ✅ \`make\`\n- ❌ ${x}\n`, "a failure with no exit code"],
    ]) {
      assert.equal(runVerdict(checks, content), "false", label);
    }
  });
});
