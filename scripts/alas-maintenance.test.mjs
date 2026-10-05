import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditDownstreamPatches,
  validateClaudePatchIdentities,
} from "./audit-downstream-patches.mjs";
import { buildProtectedIntegration, buildSyncCandidate } from "./build-sync-candidate.mjs";
import { verifyAlasSource } from "./verify-alas-source.mjs";

const roots = [];
const CLAUDE_PATCHES = [
  {
    name: "goal-capability-opt-in",
    identityCommit: "60749d07ff50308ef96c5251152a8d4986fe680f",
    commit: "60749d07ff50308ef96c5251152a8d4986fe680f",
    upstreamPr: 1245,
    files: ["docs/air-extensions.md", "src/acp-agent.ts", "src/goal-extension.ts"],
    tests: ["src/tests/acp-agent.test.ts"],
  },
  {
    name: "async-tasks-opt-in",
    identityCommit: "3e098c71628cc7d5927ee8a3d794faa433dce12d",
    commit: "3e098c71628cc7d5927ee8a3d794faa433dce12d",
    upstreamPr: null,
    files: ["src/acp-agent.ts", "src/async-tasks.ts"],
    tests: ["src/tests/acp-agent.test.ts", "src/tests/async-tasks.test.ts"],
  },
];

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
    git("update-ref", "refs/test-target", "v1.1.0");

    const result = auditDownstreamPatches({
      cwd,
      targetRef: "refs/test-target",
      targetTag: "v1.1.0",
      enforceKnownIdentities: false,
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

    expect(result).toEqual(
      expect.objectContaining({
        baseTag: "v1.0.0",
        targetRef: "v1.1.0",
        targetCommit: git("rev-parse", "v1.1.0"),
      }),
    );
    expect(result.patches).toEqual([
      expect.objectContaining({ name: "feature-opt-in", status: expected }),
    ]);
    expect(result.manualReview).toBe(manualReview);
  });

  it("resolves the ledger base tag through the fetched upstream tag ref", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { "src/base.ts": "base\n" });
    git("update-ref", "refs/alas-upstream-tags/v1.0.0", "HEAD");
    const patchCommit = commit("downstream patch", { "src/feature.ts": "downstream\n" });
    git("reset", "-q", "--hard", "HEAD~1");
    commit("upstream overlap", { "src/feature.ts": "upstream different\n" });
    git("update-ref", "refs/alas-upstream-tags/v1.1.0", "HEAD");

    const result = auditDownstreamPatches({
      cwd,
      targetRef: "refs/alas-upstream-tags/v1.1.0",
      targetTag: "v1.1.0",
      baseRef: "refs/alas-upstream-tags/v1.0.0",
      enforceKnownIdentities: false,
      ledger: {
        version: 1,
        baseTag: "v1.0.0",
        patches: [
          {
            name: "feature-opt-in",
            commit: patchCommit,
            upstreamPr: null,
            files: ["src/feature.ts"],
            tests: ["src/tests/feature.test.ts"],
          },
        ],
      },
    });

    expect(result.baseTag).toBe("v1.0.0");
    expect(result.changedFiles).toEqual(["src/feature.ts"]);
    expect(result.patches).toEqual([
      expect.objectContaining({ name: "feature-opt-in", status: "overlap" }),
    ]);
  });

  it.each([
    ["missing", (patches) => patches.slice(0, 1)],
    ["duplicate", (patches) => [patches[0], patches[0]]],
    ["renamed", (patches) => [{ ...patches[0], name: "renamed-opt-in" }, patches[1]]],
    [
      "substituted",
      (patches) => [
        { ...patches[0], identityCommit: "f".repeat(40), commit: "f".repeat(40) },
        patches[1],
      ],
    ],
    [
      "unexpected",
      (patches) => [
        ...patches,
        {
          name: "unexpected-functional-patch",
          identityCommit: "e".repeat(40),
          commit: "e".repeat(40),
          upstreamPr: null,
          files: ["src/unexpected.ts"],
          tests: ["src/tests/unexpected.test.ts"],
        },
      ],
    ],
  ])("rejects a %s functional patch identity", (_label, mutate) => {
    const { cwd } = fixture();
    const ledger = {
      version: 1,
      baseTag: "v1.0.0",
      patches: mutate(structuredClone(CLAUDE_PATCHES)),
    };
    expect(() => auditDownstreamPatches({ cwd, ledger, targetRef: "v1.1.0" })).toThrow(
      /exact.*patch identities|patch identities.*exact/i,
    );
  });

  it("keeps the original identity anchored across an authenticated second adaptation", () => {
    const ledger = {
      version: 1,
      baseTag: "v1.2.0",
      patches: structuredClone(CLAUDE_PATCHES),
    };
    ledger.patches[0] = {
      ...ledger.patches[0],
      commit: "d".repeat(40),
      disposition: "active",
      retiredCommits: [ledger.patches[0].identityCommit, "c".repeat(40)],
      lastResolution: {
        fromTag: "v1.1.0",
        toTag: "v1.2.0",
        originalCommit: "c".repeat(40),
        replacementCommit: "d".repeat(40),
        decision: "adapt",
      },
    };
    expect(() => validateClaudePatchIdentities(ledger)).not.toThrow();
  });

  it("ignores retired patches and audits an adapted replacement on the next sync", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { "src/base.ts": "base\n" });
    git("tag", "v1.0.0");
    git("switch", "-c", "patches");
    const dropped = commit("old downstream patch", { "src/dropped.ts": "old\n" });
    const adapted = commit("adapted downstream patch", { "src/adapted.ts": "adapted\n" });
    git("switch", "main");
    commit("stable one", { "src/stable.ts": "one\n" });
    git("tag", "v1.1.0");
    commit("stable two", { "src/stable.ts": "two\n" });
    git("tag", "v1.2.0");

    const result = auditDownstreamPatches({
      cwd,
      targetRef: "v1.2.0",
      enforceKnownIdentities: false,
      ledger: {
        version: 1,
        baseTag: "v1.1.0",
        patches: [
          {
            name: "dropped",
            commit: dropped,
            upstreamPr: null,
            files: ["src/dropped.ts"],
            tests: ["src/tests/dropped.test.ts"],
            disposition: "dropped",
            retiredCommits: [dropped],
          },
          {
            name: "adapted",
            commit: adapted,
            upstreamPr: null,
            files: ["src/adapted.ts"],
            tests: ["src/tests/adapted.test.ts"],
            disposition: "active",
            retiredCommits: [dropped],
          },
        ],
      },
    });

    expect(result.patches).toEqual([
      expect.objectContaining({ name: "adapted", commit: adapted, status: "unaffected" }),
    ]);
  });
});

describe("buildSyncCandidate", () => {
  it("reconstructs the same candidate under different local Git identities", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    git("branch", "alas");
    git("switch", "alas");
    commit("downstream patch", { "src/downstream.ts": "downstream\n" });
    git("switch", "main");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");

    git("config", "user.name", "First Maintainer");
    git("config", "user.email", "first@example.test");
    const first = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "candidate-first",
    });

    git("config", "user.name", "Second Maintainer");
    git("config", "user.email", "second@example.test");
    const second = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "candidate-second",
    });

    expect(second.candidateCommit).toBe(first.candidateCommit);
    expect(git("show", "-s", "--format=%cn%n%ce", second.candidateCommit)).toBe(
      "github-actions[bot]\n41898282+github-actions[bot]@users.noreply.github.com",
    );
  });

  it("starts at the exact tag and preserves only canonical same-version edits for manual review", () => {
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
    git("switch", "-c", "sync/upstream-1.1.0");
    const canonicalEdit = commit("same-version maintainer edit", {
      "docs/manual.md": "preserve me\n",
    });
    git("switch", "alas");
    git("switch", "-c", "sync/upstream-1.0.1");
    commit("stale maintainer edit", { "docs/stale.md": "do not replay\n" });
    git("switch", "alas");

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: git("rev-parse", "sync/upstream-1.1.0"),
    });

    expect(result.baseCommit).toBe(stableCommit);
    expect(git("merge-base", "HEAD", "upstream-main")).toBe(stableCommit);
    expect(readFileSync(join(cwd, "src/downstream.ts"), "utf8")).toBe("downstream\n");
    expect(readFileSync(join(cwd, "docs/manual.md"), "utf8")).toBe("preserve me\n");
    expect(() => readFileSync(join(cwd, "docs/stale.md"), "utf8")).toThrow();
    expect(() => readFileSync(join(cwd, "src/preview.ts"), "utf8")).toThrow();
    expect(result.preservedCommits).toEqual([
      expect.objectContaining({ commit: canonicalEdit, subject: "same-version maintainer edit" }),
    ]);
    expect(result.manualReview).toBe(true);
  });

  it("fails closed when the canonical sync ref moved after selection", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    git("branch", "upstream-main");
    git("branch", "alas");
    git("branch", "sync/upstream-1.0.0");

    expect(() =>
      buildSyncCandidate({
        cwd,
        targetRef: "v1.0.0",
        alasRef: "alas",
        upstreamMainRef: "upstream-main",
        branch: "exact/upstream-1.0.0",
        canonicalSyncRef: "sync/upstream-1.0.0",
        expectedCanonicalCommit: "a".repeat(40),
      }),
    ).toThrow(/moved/);
  });

  it("does not replay a downstream patch with an explicit drop resolution", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    git("branch", "alas");
    git("switch", "alas");
    const patchCommit = commit("downstream patch", { "src/patch.ts": "downstream\n" });
    git("switch", "main");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
      review: {
        fromTag: "v1.0.0",
        toTag: "v1.1.0",
        patches: [{ commit: patchCommit, resolution: { decision: "drop" } }],
      },
    });

    expect(() => readFileSync(join(cwd, "src/patch.ts"), "utf8")).toThrow();
    expect(result.skippedCommits).toEqual([patchCommit]);
  });

  it("carries canonical review state without creating recursive manual review", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    git("branch", "alas");
    git("switch", "-c", "sync/upstream-1.1.0", "alas");
    const reviewCommit = commit("review resolution", {
      "docs/ALAS_SYNC_REVIEW.json": '{"resolved":true}\n',
    });

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: reviewCommit,
    });

    expect(result.preservedCommits).toEqual([]);
    expect(result.reviewCommits).toEqual([
      expect.objectContaining({ commit: reviewCommit, subject: "review resolution" }),
    ]);
    expect(result.manualReview).toBe(false);
  });

  it("recognizes a review-only merge commit as regenerated review state", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    git("branch", "alas");
    git("switch", "-c", "sync/upstream-1.1.0", "alas");
    git("switch", "-c", "review-state");
    commit("edit review state", { "docs/ALAS_SYNC_REVIEW.json": '{"resolved":true}\n' });
    git("switch", "sync/upstream-1.1.0");
    git("merge", "--no-ff", "review-state", "-m", "merge review state");
    const reviewMerge = git("rev-parse", "HEAD");

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: reviewMerge,
    });

    expect(result.preservedCommits).toEqual([]);
    expect(result.reviewCommits).toEqual([
      expect.objectContaining({ commit: reviewMerge, subject: "merge review state" }),
    ]);
    expect(result.manualReview).toBe(false);
  });

  it("does not replay review-only commits from protected alas as package content", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    git("branch", "alas");
    git("switch", "alas");
    const reviewCommit = commit("old review state", {
      "docs/ALAS_SYNC_REVIEW.json": '{"toTag":"v1.0.0"}\n',
    });
    git("switch", "main");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
    });

    expect(() => readFileSync(join(cwd, "docs/ALAS_SYNC_REVIEW.json"), "utf8")).toThrow();
    expect(result.reviewCommits).toEqual([
      expect.objectContaining({ commit: reviewCommit, subject: "old review state" }),
    ]);
  });

  it("uses an explicit adaptation commit instead of a conflicting downstream patch", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { "src/feature.ts": "base\n" });
    git("tag", "v1.0.0");
    git("branch", "alas");
    git("switch", "alas");
    const patchCommit = commit("downstream patch", { "src/feature.ts": "downstream\n" });
    git("switch", "main");
    commit("upstream overlap", { "src/feature.ts": "upstream\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    git("switch", "-c", "adaptation", "v1.1.0");
    const adaptationCommit = commit("adapt downstream patch", {
      "src/feature.ts": "upstream with downstream opt-in\n",
    });

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
      review: {
        fromTag: "v1.0.0",
        toTag: "v1.1.0",
        patches: [
          {
            commit: patchCommit,
            resolution: { decision: "adapt", commit: adaptationCommit },
          },
        ],
      },
    });

    expect(readFileSync(join(cwd, "src/feature.ts"), "utf8")).toBe(
      "upstream with downstream opt-in\n",
    );
    expect(result.skippedCommits).toEqual([patchCommit]);
    expect(result.adaptationCommits).toEqual([
      expect.objectContaining({ commit: adaptationCommit, subject: "adapt downstream patch" }),
    ]);
  });

  it("does not replay a preserved sync edit whose review resolution is drop", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    git("branch", "alas");
    git("switch", "-c", "sync/upstream-1.1.0", "alas");
    const edit = commit("discarded edit", { "docs/discard.md": "discard\n" });

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: edit,
      review: {
        toTag: "v1.1.0",
        preservedCommits: [{ commit: edit, resolution: { decision: "drop" } }],
        patches: [],
      },
    });

    expect(() => readFileSync(join(cwd, "docs/discard.md"), "utf8")).toThrow();
    expect(result.preservedCommits).toEqual([
      expect.objectContaining({ commit: edit, subject: "discarded edit" }),
    ]);
    expect(result.manualReview).toBe(true);
  });

  it("rejects preserved review commits that are not on the canonical sync branch", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    git("branch", "alas");
    git("switch", "-c", "unrelated", "v1.1.0");
    const injected = commit("injected edit", { "docs/injected.md": "injected\n" });
    git("switch", "-c", "sync/upstream-1.1.0", "alas");
    const canonical = commit("canonical edit", { "docs/canonical.md": "canonical\n" });

    expect(() =>
      buildSyncCandidate({
        cwd,
        targetRef: "v1.1.0",
        alasRef: "alas",
        upstreamMainRef: "upstream-main",
        branch: "exact/upstream-1.1.0",
        canonicalSyncRef: "sync/upstream-1.1.0",
        expectedCanonicalCommit: canonical,
        review: {
          toTag: "v1.1.0",
          preservedCommits: [{ commit: injected, resolution: { decision: "retain" } }],
          patches: [],
        },
      }),
    ).toThrow(/canonical sync branch/i);
  });

  it("does not resurrect a retired patch from an earlier cherry-picked copy", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    git("branch", "alas");
    git("switch", "alas");
    const original = commit("downstream patch", { "src/retired.ts": "retired\n" });
    git("switch", "main");
    commit("stable one", { stable: "one\n" });
    git("tag", "v1.1.0");
    const upstreamMain = commit("stable two", { stable: "two\n" });
    git("tag", "v1.2.0");
    git("branch", "upstream-main", upstreamMain);
    git("switch", "-c", "first-candidate", "v1.1.0");
    git("cherry-pick", original);
    const copied = git("rev-parse", "HEAD");
    const integration = buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      candidateRef: copied,
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "integrated-alas",
    });

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.2.0",
      alasRef: integration.integrationCommit,
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.2.0",
      ledger: {
        patches: [
          {
            name: "retired",
            commit: original,
            disposition: "dropped",
            retiredCommits: [original],
          },
        ],
      },
    });

    expect(() => readFileSync(join(cwd, "src/retired.ts"), "utf8")).toThrow();
    expect(result.skippedCommits).toEqual(expect.arrayContaining([original, copied]));
  });

  it("preserves a canonical merge edit as one manual-review change", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    git("branch", "alas");
    git("switch", "-c", "sync/upstream-1.1.0", "alas");
    git("switch", "-c", "reviewed-side-edit");
    commit("side edit", { "docs/merged.md": "merged\n" });
    git("switch", "sync/upstream-1.1.0");
    git("merge", "--no-ff", "reviewed-side-edit", "-m", "chore: integrate upstream v1.1.0");
    const mergeEdit = git("rev-parse", "HEAD");

    const result = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "exact/upstream-1.1.0",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: mergeEdit,
    });

    expect(readFileSync(join(cwd, "docs/merged.md"), "utf8")).toBe("merged\n");
    expect(result.preservedCommits).toEqual([
      expect.objectContaining({
        commit: mergeEdit,
        subject: "chore: integrate upstream v1.1.0",
      }),
    ]);
    expect(result.manualReview).toBe(true);
  });
});

describe("buildProtectedIntegration", () => {
  it("creates a deterministic no-ff integration branch descended from alas", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("old preview later contained by stable", { preview: "contained\n" });
    const oldContamination = git("rev-parse", "HEAD");
    git("branch", "alas");
    commit("new stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    git("switch", "-c", "exact/upstream-1.1.0", "v1.1.0");
    commit("downstream replay", { downstream: "downstream\n" });
    const candidate = git("rev-parse", "HEAD");

    const first = buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      candidateRef: candidate,
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "sync/upstream-1.1.0",
    });
    const second = buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      candidateRef: candidate,
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "sync/upstream-1.1.0",
    });

    expect(first.integrationCommit).toBe(second.integrationCommit);
    expect(git("rev-parse", `${first.integrationCommit}^1`)).toBe(git("rev-parse", "alas"));
    expect(git("rev-parse", `${first.integrationCommit}^2`)).toBe(candidate);
    expect(git("rev-parse", `${first.integrationCommit}^{tree}`)).toBe(
      git("rev-parse", `${candidate}^{tree}`),
    );
    expect(git("merge-base", first.integrationCommit, "upstream-main")).toBe(
      git("rev-parse", "v1.1.0"),
    );
    expect(first.previousUpstreamBase).toBe(oldContamination);
  });

  it("fails closed when the old contamination is not contained by the target tag", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    git("switch", "-c", "target-line");
    commit("stable on target line", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("switch", "main");
    commit("uncontained preview", { preview: "not in target\n" });
    git("branch", "alas");
    git("merge", "--no-edit", "target-line");
    git("branch", "upstream-main");
    git("switch", "-c", "exact/upstream-1.1.0", "v1.1.0");
    const candidate = commit("downstream replay", { downstream: "downstream\n" });

    expect(() =>
      buildProtectedIntegration({
        cwd,
        targetRef: "v1.1.0",
        candidateRef: candidate,
        alasRef: "alas",
        upstreamMainRef: "upstream-main",
        branch: "sync/upstream-1.1.0",
      }),
    ).toThrow(/not contained by target/i);
  });

  it("always emits a deterministic integration instead of reusing a same-tree canonical head", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("contained preview", { preview: "contained\n" });
    git("branch", "alas");
    git("switch", "alas");
    commit("downstream", { downstream: "downstream\n" });
    git("switch", "main");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    const initialCandidate = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "candidate",
    });
    const candidate = initialCandidate.candidateCommit;
    buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      candidateRef: candidate,
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "sync/upstream-1.1.0",
    });
    const reviewedEdit = commit("reviewed sync edit", { "docs/reviewed.md": "reviewed\n" });

    const rebuiltCandidate = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "candidate-rerun",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: reviewedEdit,
    });
    const rerun = buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      candidateRef: rebuiltCandidate.candidateCommit,
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "sync/upstream-1.1.0",
      canonicalSyncRef: reviewedEdit,
      expectedCanonicalCommit: reviewedEdit,
    });

    expect(rerun.integrationCommit).not.toBe(reviewedEdit);
    expect(rerun.reused).toBe(false);
    expect(
      git("rev-list", "--parents", "-n", "1", rerun.integrationCommit).split(" ").slice(1),
    ).toEqual([git("rev-parse", "alas"), rebuiltCandidate.candidateCommit, reviewedEdit]);
  });

  it("reuses reviewed edits reachable through a prior integration third parent", () => {
    const { cwd, git, commit } = fixture();
    commit("base", { base: "base\n" });
    git("tag", "v1.0.0");
    commit("contained preview", { preview: "contained\n" });
    git("branch", "alas");
    git("switch", "main");
    commit("stable", { stable: "stable\n" });
    git("tag", "v1.1.0");
    git("branch", "upstream-main");
    const initialCandidate = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "candidate",
    });
    buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      candidateRef: initialCandidate.candidateCommit,
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "sync/upstream-1.1.0",
    });
    const reviewedEdit = commit("reviewed sync edit", { "docs/reviewed.md": "reviewed\n" });
    const review = {
      toTag: "v1.1.0",
      toCommit: git("rev-parse", "v1.1.0"),
      patches: [],
      preservedCommits: [{ commit: reviewedEdit, resolution: { decision: "drop" } }],
    };
    const droppedCandidate = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "candidate-drop",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: reviewedEdit,
      review,
    });
    const integrated = buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      candidateRef: droppedCandidate.candidateCommit,
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "sync/upstream-1.1.0",
      canonicalSyncRef: reviewedEdit,
      expectedCanonicalCommit: reviewedEdit,
    });
    expect(
      git("rev-list", "--parents", "-n", "1", integrated.integrationCommit).split(" "),
    ).toHaveLength(4);

    const rerun = buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: "alas",
      upstreamMainRef: "upstream-main",
      branch: "candidate-drop-rerun",
      canonicalSyncRef: "sync/upstream-1.1.0",
      expectedCanonicalCommit: integrated.integrationCommit,
      review,
    });

    expect(rerun.preservedCommits).toEqual([
      expect.objectContaining({ commit: reviewedEdit, subject: "reviewed sync edit" }),
    ]);
    expect(() => readFileSync(join(cwd, "docs/reviewed.md"), "utf8")).toThrow();
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
