import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProtectedIntegration, buildSyncCandidate } from "./build-sync-candidate.mjs";
import { verifySyncSourceReview } from "./verify-sync-source-review.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-source-review-"));
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
      const full = join(cwd, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    }
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, commit };
}

function sourceFixture({ decision = "retain", unreviewedMerge = false } = {}) {
  const { cwd, git, commit } = fixture();
  commit("base", { base: "base\n" });
  git("tag", "v1.0.0");
  commit("contained preview", { preview: "contained\n" });
  git("branch", "alas");
  git("switch", "alas");
  const downstream = commit("downstream", { downstream: "downstream\n" });
  git("switch", "main");
  commit("stable", { stable: "stable\n" });
  git("tag", "v1.1.0");
  git("branch", "upstream-main");
  const firstCandidate = buildSyncCandidate({
    cwd,
    targetRef: "v1.1.0",
    alasRef: "alas",
    upstreamMainRef: "upstream-main",
    branch: "candidate",
  });
  buildProtectedIntegration({
    cwd,
    targetRef: "v1.1.0",
    targetTag: "v1.1.0",
    candidateRef: firstCandidate.candidateCommit,
    alasRef: "alas",
    upstreamMainRef: "upstream-main",
    branch: "sync/upstream-1.1.0",
  });
  const preserved = commit("maintainer sync edit", { "docs/manual.md": "preserve\n" });
  let adaptation;
  if (decision === "adapt") {
    git("switch", "-c", "adaptation", "v1.1.0");
    adaptation = commit("adapt maintainer edit", { "docs/manual.md": "adapted\n" });
    git("switch", "sync/upstream-1.1.0");
  }
  const resolution = { decision, ...(adaptation ? { commit: adaptation } : {}) };
  const review = {
    fromTag: "v1.0.0",
    toTag: "v1.1.0",
    toCommit: git("rev-parse", "v1.1.0"),
    patches: [],
    preservedCommits: [
      {
        commit: preserved,
        subject: "maintainer sync edit",
        resolution,
      },
    ],
  };
  const candidate = buildSyncCandidate({
    cwd,
    targetRef: "v1.1.0",
    alasRef: "alas",
    upstreamMainRef: "upstream-main",
    branch: "candidate-rerun",
    canonicalSyncRef: "sync/upstream-1.1.0",
    expectedCanonicalCommit: preserved,
    review,
  });
  const integration = buildProtectedIntegration({
    cwd,
    targetRef: "v1.1.0",
    targetTag: "v1.1.0",
    candidateRef: candidate.candidateCommit,
    alasRef: "alas",
    upstreamMainRef: "upstream-main",
    branch: "sync/upstream-1.1.0",
    canonicalSyncRef: preserved,
    expectedCanonicalCommit: preserved,
  });
  let sourceCommit = integration.integrationCommit;
  if (unreviewedMerge) {
    git("switch", "-c", "unreviewed-side");
    commit("unreviewed side edit", { "docs/unreviewed.md": "unreviewed\n" });
    git("switch", "sync/upstream-1.1.0");
    git("merge", "--no-ff", "unreviewed-side", "-m", "unreviewed merge edit");
    sourceCommit = git("rev-parse", "HEAD");
  }
  return { cwd, git, downstream, preserved, review, sourceCommit };
}

const ledger = { version: 1, baseTag: "v1.1.0", patches: [] };

describe("verifySyncSourceReview", () => {
  it("accepts a review that lists every preserved sync-only commit", () => {
    const { cwd, preserved, review, sourceCommit } = sourceFixture();
    expect(
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toEqual(expect.objectContaining({ preservedCommits: [preserved] }));
  });

  it("rejects a review that adds an ancestor which was not a canonical sync edit", () => {
    const { cwd, downstream, review, sourceCommit } = sourceFixture();
    review.preservedCommits.push({
      commit: downstream,
      subject: "downstream",
      resolution: { decision: "retain" },
    });
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toThrow(/canonical preserved sync edits/i);
  });

  it("rejects a review that omits a preserved sync-only commit", () => {
    const { cwd, review, sourceCommit } = sourceFixture();
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review: { ...review, preservedCommits: [] },
        ledger,
      }),
    ).toThrow(/source tree does not match/i);
  });

  it.each(["drop", "adapt"])(
    "accepts a preserved %s resolution reflected in the source tree",
    (decision) => {
      const { cwd, preserved, review, sourceCommit } = sourceFixture({ decision });
      const result = verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      });
      expect(result).toEqual(expect.objectContaining({ preservedCommits: [preserved] }));
      expect(result.integrationCommit).toBe(sourceCommit);
    },
  );

  it("uses the fetched target ref when the local tag is absent", () => {
    const { cwd, git, review, sourceCommit } = sourceFixture();
    git("update-ref", "refs/alas-upstream-tag", "v1.1.0");
    git("tag", "-d", "v1.1.0");
    expect(
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetRef: "refs/alas-upstream-tag",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toEqual(expect.objectContaining({ sourceCommit }));
  });

  it("rejects a preserved resolution that does not match the source tree", () => {
    const { cwd, review, sourceCommit } = sourceFixture();
    review.preservedCommits[0].resolution = { decision: "drop" };
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toThrow(/source tree does not match/i);
  });

  it("rejects an unreviewed merge-only edit in the publication source", () => {
    const { cwd, review, sourceCommit } = sourceFixture({ unreviewedMerge: true });
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toThrow(/source tree does not match/i);
  });
});
