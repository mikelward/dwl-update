// Tests for this repository's lane policy, .github/lanes.conf, ported from
// mikelward/rust-update. The policy's failure mode is the quiet one: a
// broadened rule makes classify and gate derive the same wrong docs verdict,
// so the suite skips under a green required check. So the rules are
// exercised here, both directions, with `path.matchesGlob`, the primitive
// the engine (mikelward/lanes) matches with.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

const text = readFileSync(new URL("./.github/lanes.conf", import.meta.url), "utf8");

const lines = text
  .split("\n")
  .map((line) => {
    const comment = line.search(/\s#/);
    return (comment === -1 ? line : line.slice(0, comment)).trim();
  })
  .filter((line) => line && !line.startsWith("#"));

const rules = [];
const directives = {};
for (const line of lines) {
  const [word, ...rest] = line.split(/\s+/);
  if (word === "docs" || word === "code") rules.push({ verdict: word, pattern: rest.join(" ") });
  else directives[word] = rest;
}

const classify = (path) => {
  for (const { verdict, pattern } of rules) {
    if (matchesGlob(path, pattern)) return verdict;
  }
  return "code";
};

describe("the lane policy", () => {
  test("parses to the scaffold's shape, nothing wider", () => {
    assert.deepEqual(rules, [
      { verdict: "docs", pattern: "*.md" },
      { verdict: "docs", pattern: "**/docs/*.md" },
    ]);
    assert.deepEqual(directives.prefixes, ["docs", "todo"]);
    assert.deepEqual(directives["lint-title"], ["no"]);
  });

  test("root markdown rides the docs lane", () => {
    for (const path of ["README.md", "TODO.md"]) assert.equal(classify(path), "docs", path);
  });

  test("everything a consumer's weekly run executes, and the suite, is code", () => {
    for (const path of [
      ".github/workflows/dwl-update.yml",
      ".github/workflows/ci.yml",
      ".github/zizmor.yml",
      ".github/lanes.conf",
      "workflow.test.js",
    ]) {
      assert.equal(classify(path), "code", path);
    }
  });
});
