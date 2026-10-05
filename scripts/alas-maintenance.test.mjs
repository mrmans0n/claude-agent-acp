import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditDownstreamPatches } from "./audit-downstream-patches.mjs";
import { buildSyncCandidate } from "./build-sync-candidate.mjs";
import { verifyAlasSource } from "./verify-alas-source.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alas-maintenance-"));
  roots.push(root);
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const commit = (message, files) => {
    for (const [path, contents] of Object.entries(files)) {
      const fullPath = join(cwd, path);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, contents);
    }
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, commit };
}

describe("auditDownstreamPatches", () => {
  it.each([
    ["unaffected", false],
    ["absorbed", true],
    ["overlap", true],
  ])("classifies a downstream patch as %s", (expected, manualReview) => {
    const { cwd, git, commit } = fixture();
    commit("base", { "src/base.ts": "base\n" });
    git("tag", "v1.0.0");
    git("switch", "-c", "patch");
    const patchCommit = commit("downstream patch", {
      "src/feature.ts": "downstream\n",
      "src/tests/feature.test.ts": "test\n",
    });
    git("switch", "main");
    if (expected === "absorbed") {
      git("cherry-pick", patchCommit);
      git("commit", "--amend", "-qm", "upstream equivalent");
    } else if (expected === "overlap") {
      commit("upstream overlap", { "src/feature.ts": "upstream different\n" });
    } else {
      commit("upstream unrelated", { "src/unrelated.ts": "upstream\n" });
    }
    git("tag", "v1.1.0");

    const result = auditDownstreamPatches({
      cwd,
      targetRef: "v1.1.0",
      ledger: {
        version: 1,
        baseTag: "v1.0.0",
        patches: [
          {
            name: "feature-opt-in",
            commit: patchCommit,
            upstreamPr: 123,
            files: ["src/feature.ts"],
            tests: ["src/tests/feature.test.ts"],
          },
        ],
      },
    });

    expect(result.patches).toEqual([
      expect.objectContaining({ name: "feature-opt-in", status: expected }),
    ]);
    expect(result.manualReview).toBe(manualReview);
  });
});

describe("buildSyncCandidate", () => {
  it("starts at the exact stable tag, excludes later upstream previews, and reapplies downstream and sync-only commits", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { "src/base.ts": "base\n" });
    git("tag", "v1.0.0");
    commit("stable", { "src/stable.ts": "stable\n" });
    git("tag", "v1.1.0");
    const stableCommit = git("rev-parse", "v1.1.0");
    commit("preview after stable", { "src/preview.ts": "must not leak\n" });
    git("branch", "upstream-main");
    git("switch", "-c", "alas");
    commit("downstream patch", { "src/downstream.ts": "downstream\n" });
    const alasHead = git("rev-parse", "HEAD");
    git("switch", "-c", "sync/upstream-1.0.1");
    commit("maintainer sync edit", { "docs/manual.md": "preserve me\n" });
    const syncHead = git("rev-parse", "HEAD");

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "sync/upstream-1.1.0",
      syncRefs: [{ ref: "sync/upstream-1.0.1", expectedCommit: syncHead }],
    });

    expect(result.baseCommit).toBe(stableCommit);
    expect(git("merge-base", "HEAD", "upstream-main")).toBe(stableCommit);
    expect(readFileSync(join(cwd, "src/downstream.ts"), "utf8")).toBe("downstream\n");
    expect(readFileSync(join(cwd, "docs/manual.md"), "utf8")).toBe("preserve me\n");
    expect(() => readFileSync(join(cwd, "src/preview.ts"), "utf8")).toThrow();
    expect(result.downstreamCommits).toHaveLength(1);
    expect(result.preservedCommits).toHaveLength(1);
    expect(alasHead).not.toBe(git("rev-parse", "HEAD"));
  });

  it("fails closed when a sync ref moved after selection", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    git("branch", "upstream-main");
    git("branch", "alas");
    git("branch", "sync/upstream-0.9.0");

    expect(() =>
      buildSyncCandidate({
        cwd,
        targetRef: "v1.0.0",
        alasRef: "alas",
        upstreamMainRef: "upstream-main",
        branch: "sync/upstream-1.0.0",
        syncRefs: [{ ref: "sync/upstream-0.9.0", expectedCommit: "a".repeat(40) }],
      }),
    ).toThrow(/moved/);
  });
});

describe("verifyAlasSource", () => {
  it("accepts only a source whose merge-base with upstream main is the declared stable tag", () => {
    const { cwd, git, commit } = fixture();
    commit("stable", { base: "stable\n", "package.json": '{"version":"1.0.0"}\n' });
    git("tag", "v1.0.0");
    const stableCommit = git("rev-parse", "v1.0.0");
    git("switch", "-c", "clean-source");
    const cleanSource = commit("downstream", { downstream: "clean\n" });
    git("switch", "main");
    commit("preview", { preview: "contamination\n" });
    git("branch", "upstream-main");
    git("switch", "-c", "contaminated-source");
    const contaminatedSource = commit("downstream on preview", { downstream: "dirty\n" });

    expect(
      verifyAlasSource({
        cwd,
        sourceCommit: cleanSource,
        upstreamMainRef: "upstream-main",
        stableTagRef: "v1.0.0",
        declaredTag: "v1.0.0",
      }),
    ).toEqual(expect.objectContaining({ stableCommit, mergeBase: stableCommit }));
    expect(() =>
      verifyAlasSource({
        cwd,
        sourceCommit: contaminatedSource,
        upstreamMainRef: "upstream-main",
        stableTagRef: "v1.0.0",
        declaredTag: "v1.0.0",
      }),
    ).toThrow(/merge-base.*does not equal/i);
  });
});
