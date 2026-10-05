import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProtectedIntegration,
  buildSyncCandidate,
  recordSyncReviewState,
} from "./build-sync-candidate.mjs";
import { advanceLedgerBaseTag } from "./sync-review.mjs";
import { verifySyncSourceReview } from "./verify-sync-source-review.mjs";

const roots = [];
vi.setConfig({ testTimeout: 15_000 });
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

function sourceFixture({
  decision = "retain",
  preservedCount = 1,
  reviewOnlyMetadata = false,
  unreviewedMerge = false,
} = {}) {
  const { cwd, git, commit } = fixture();
  commit("base", { base: "base\n" });
  git("tag", "v1.0.0");
  commit("contained preview", { preview: "contained\n" });
  git("branch", "alas");
  git("switch", "alas");
  const downstream = commit("downstream", { downstream: "downstream\n" });
  const previousLedger = { version: 1, baseTag: "v1.0.0", patches: [] };
  commit("record previous ledger", {
    "docs/ALAS_DOWNSTREAM_PATCHES.json": `${JSON.stringify(previousLedger, null, 2)}\n`,
  });
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
  const secondPreserved =
    preservedCount > 1
      ? commit("second maintainer sync edit", { "docs/second-manual.md": "preserve too\n" })
      : undefined;
  let adaptation;
  if (decision === "adapt") {
    git("switch", "-c", "adaptation", "v1.1.0");
    adaptation = commit("adapt maintainer edit", { "docs/manual.md": "adapted\n" });
    git("switch", "sync/upstream-1.1.0");
  }
  const resolution = { decision, ...(adaptation ? { commit: adaptation } : {}) };
  const review = {
    version: 1,
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
      ...(secondPreserved
        ? [
            {
              commit: secondPreserved,
              subject: "second maintainer sync edit",
              resolution: { decision: "retain" },
            },
          ]
        : []),
    ],
    resolved: true,
  };
  const ledger = advanceLedgerBaseTag({ ledger: previousLedger, review }).ledger;
  buildSyncCandidate({
    cwd,
    targetRef: "v1.1.0",
    alasRef: "alas",
    upstreamMainRef: "upstream-main",
    branch: "candidate-rerun",
    canonicalSyncRef: "sync/upstream-1.1.0",
    expectedCanonicalCommit: secondPreserved ?? preserved,
    review,
    ledger,
  });
  recordSyncReviewState({
    cwd,
    targetRef: "v1.1.0",
    targetTag: "v1.1.0",
    review,
    ledger,
  });
  const integration = buildProtectedIntegration({
    cwd,
    targetRef: "v1.1.0",
    targetTag: "v1.1.0",
    candidateRef: "HEAD",
    alasRef: "alas",
    upstreamMainRef: "upstream-main",
    branch: "sync/upstream-1.1.0",
    canonicalSyncRef: secondPreserved ?? preserved,
    expectedCanonicalCommit: secondPreserved ?? preserved,
  });
  let sourceCommit = integration.integrationCommit;
  let reviewOnlyCommit;
  if (reviewOnlyMetadata) {
    reviewOnlyCommit = commit("review-only metadata", {
      "docs/ALAS_SYNC_REVIEW.json": `${JSON.stringify({ ...review, note: "metadata only" }, null, 2)}\n`,
    });
    sourceCommit = reviewOnlyCommit;
  }
  if (unreviewedMerge) {
    git("switch", "-c", "unreviewed-side");
    commit("unreviewed side edit", { "docs/unreviewed.md": "unreviewed\n" });
    git("switch", "sync/upstream-1.1.0");
    git("merge", "--no-ff", "unreviewed-side", "-m", "unreviewed merge edit");
    sourceCommit = git("rev-parse", "HEAD");
  }
  return {
    cwd,
    git,
    commit,
    downstream,
    preserved,
    secondPreserved,
    reviewOnlyCommit,
    review,
    ledger,
    previousLedger,
    sourceCommit,
  };
}

describe("verifySyncSourceReview", () => {
  it("accepts a review that lists every preserved sync-only commit", () => {
    const { cwd, preserved, review, ledger, sourceCommit } = sourceFixture();
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
    const { cwd, downstream, review, ledger, sourceCommit } = sourceFixture();
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
    ).toThrow(/canonical preserved sync edits|exact reviewed|merge wrapper/i);
  });

  it("rejects a review that omits a dropped canonical preserved commit", () => {
    const { cwd, review, ledger, sourceCommit } = sourceFixture({ decision: "drop" });
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review: { ...review, preservedCommits: [] },
        ledger,
      }),
    ).toThrow(/canonical preserved sync edits|exact reviewed|merge wrapper/i);
  });

  it("rejects a review that reorders the complete canonical preserved commit list", () => {
    const { cwd, review, ledger, sourceCommit } = sourceFixture({ preservedCount: 2 });
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review: { ...review, preservedCommits: [...review.preservedCommits].reverse() },
        ledger,
      }),
    ).toThrow(/canonical preserved sync edits|exact reviewed|merge wrapper/i);
  });

  it("rejects an unrelated commit in the preserved commit list", () => {
    const { cwd, git, commit, review, ledger, sourceCommit } = sourceFixture();
    git("switch", "-c", "unrelated", "v1.1.0");
    const unrelated = commit("unrelated", { "docs/unrelated.md": "unrelated\n" });
    git("switch", "sync/upstream-1.1.0");
    review.preservedCommits.push({
      commit: unrelated,
      subject: "unrelated",
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
    ).toThrow(/canonical source ancestry|canonical preserved sync edits/i);
  });

  it("rejects review-only metadata commits in the preserved commit list", () => {
    const { cwd, reviewOnlyCommit, review, ledger, sourceCommit } = sourceFixture({
      reviewOnlyMetadata: true,
    });
    review.preservedCommits.push({
      commit: reviewOnlyCommit,
      subject: "review-only metadata",
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
    ).toThrow(/canonical preserved sync edits|exact reviewed|merge wrapper/i);
  });

  it.each([
    [
      "an invented dropped patch record",
      (ledger, inventedCommit) => {
        ledger.patches.push({
          name: "invented-drop",
          commit: inventedCommit,
          upstreamPr: null,
          files: ["docs/invented.md"],
          tests: ["npm run test:run"],
          disposition: "dropped",
          retiredCommits: [inventedCommit],
          lastResolution: {
            fromTag: "v0.9.0",
            toTag: "v1.0.0",
            originalCommit: inventedCommit,
            decision: "drop",
          },
        });
      },
    ],
    [
      "an invented retired commit",
      (ledger, inventedCommit) => ledger.retiredCommits.push(inventedCommit),
    ],
    [
      "a preserved transition for another tag",
      (ledger, inventedCommit) => {
        ledger.preservedTransitions.push({
          fromTag: "v8.0.0",
          toTag: "v9.0.0",
          commit: inventedCommit,
          constituentCommits: [],
          decision: "drop",
        });
      },
    ],
    [
      "extra ledger state",
      (ledger) => {
        ledger.inventedState = { approved: true };
      },
    ],
  ])("rejects a committed ledger containing %s", (_description, mutate) => {
    const { cwd, git, commit, review, ledger, sourceCommit } = sourceFixture();
    git("switch", "-c", "invented-ledger-state", "v1.1.0");
    const inventedCommit = commit("invented ledger state", {
      "docs/invented.md": "not part of the sync\n",
    });
    git("switch", "sync/upstream-1.1.0");
    const tamperedLedger = structuredClone(ledger);
    mutate(tamperedLedger, inventedCommit);

    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger: tamperedLedger,
      }),
    ).toThrow(/ledger.*exact|exact.*ledger|transition/i);
  });

  it.each(["drop", "adapt"])(
    "accepts a preserved %s resolution reflected in the source tree",
    (decision) => {
      const { cwd, preserved, review, ledger, sourceCommit } = sourceFixture({ decision });
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
    const { cwd, git, review, ledger, sourceCommit } = sourceFixture();
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
    const { cwd, review, ledger, sourceCommit } = sourceFixture();
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
    ).toThrow(/ledger.*exact|exact.*ledger/i);
  });

  it("rejects an unreviewed merge-only edit in the publication source", () => {
    const { cwd, review, ledger, sourceCommit } = sourceFixture({ unreviewedMerge: true });
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toThrow(/canonical preserved sync edits|exact reviewed|merge wrapper/i);
  });

  it("rejects publication ledgers that are not anchored to the two known patch identities", () => {
    const { cwd, git, review, ledger, sourceCommit } = sourceFixture();
    const genuinePreviousAlas = git("rev-parse", `${sourceCommit}^1`);
    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        priorProtectedCommit: genuinePreviousAlas,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
        enforceKnownIdentities: true,
      }),
    ).toThrow(/two known Claude functional patch identities/i);
  });

  it("accepts a tree-identical protected-branch merge wrapper around the exact integration", () => {
    const { cwd, git, review, ledger, sourceCommit: integrationCommit } = sourceFixture();
    const genuinePreviousAlas = git("rev-parse", `${integrationCommit}^1`);
    const wrapper = git(
      "commit-tree",
      git("rev-parse", `${integrationCommit}^{tree}`),
      "-p",
      genuinePreviousAlas,
      "-p",
      integrationCommit,
      "-m",
      "Merge pull request #42 from sync/upstream-1.1.0",
    );

    expect(
      verifySyncSourceReview({
        cwd,
        sourceCommit: wrapper,
        priorProtectedCommit: genuinePreviousAlas,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toEqual(expect.objectContaining({ integrationCommit }));
  });

  it("accepts a merge wrapper whose genuine prior protected first parent descends from the prior publication anchor", () => {
    const { cwd, git, review, ledger, sourceCommit: integrationCommit } = sourceFixture();
    const genuinePreviousAlas = git("rev-parse", `${integrationCommit}^1`);
    const priorPublicationAnchor = git("rev-parse", `${genuinePreviousAlas}^1`);
    const wrapper = git(
      "commit-tree",
      git("rev-parse", `${integrationCommit}^{tree}`),
      "-p",
      genuinePreviousAlas,
      "-p",
      integrationCommit,
      "-m",
      "Merge pull request #43 from sync/upstream-1.1.0",
    );

    expect(
      verifySyncSourceReview({
        cwd,
        sourceCommit: wrapper,
        priorProtectedCommit: priorPublicationAnchor,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toEqual(expect.objectContaining({ previousAlas: genuinePreviousAlas }));
  });

  it("rejects a post-integration commit even when it changes only review metadata", () => {
    const { cwd, git, review, ledger, sourceCommit } = sourceFixture({
      reviewOnlyMetadata: true,
    });
    const integrationCommit = git("rev-parse", `${sourceCommit}^1`);
    const genuinePreviousAlas = git("rev-parse", `${integrationCommit}^1`);

    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit,
        priorProtectedCommit: genuinePreviousAlas,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toThrow(/post-integration|exact integration|merge wrapper/i);
  });

  it("rejects a same-tree candidate substitution even with the expected first parent", () => {
    const { cwd, git, preserved, review, ledger, sourceCommit } = sourceFixture();
    const genuinePreviousAlas = git("rev-parse", `${sourceCommit}^1`);
    const reviewedCandidate = git("rev-parse", `${sourceCommit}^2`);
    const substituteCandidate = git(
      "commit-tree",
      git("rev-parse", `${reviewedCandidate}^{tree}`),
      "-p",
      preserved,
      "-m",
      "same-tree substitute candidate",
    );
    const forged = buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      targetTag: "v1.1.0",
      candidateRef: substituteCandidate,
      alasRef: genuinePreviousAlas,
      upstreamMainRef: "upstream-main",
      branch: "same-tree-substitution",
      canonicalSyncRef: preserved,
      expectedCanonicalCommit: preserved,
    });

    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit: forged.integrationCommit,
        priorProtectedCommit: genuinePreviousAlas,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toThrow(/candidate|integration|exact reviewed/i);
  });

  it("rejects a lookalike integration commit with exact tree and parents but different metadata", () => {
    const { cwd, git, review, ledger, sourceCommit } = sourceFixture();
    const parents = git("rev-list", "--parents", "-n", "1", sourceCommit).split(" ").slice(1);
    const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
    const lookalike = execFileSync(
      "git",
      [
        "commit-tree",
        git("rev-parse", `${sourceCommit}^{tree}`),
        ...parents.flatMap((parent) => ["-p", parent]),
        "-m",
        "chore: integrate upstream v1.1.0",
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "github-actions[bot]",
          GIT_AUTHOR_EMAIL: botEmail,
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_NAME: "github-actions[bot]",
          GIT_COMMITTER_EMAIL: botEmail,
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      },
    ).trim();

    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit: lookalike,
        priorProtectedCommit: parents[0],
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review,
        ledger,
      }),
    ).toThrow(/exact.*integration|integration.*exact/i);
  });

  it("rejects a forged integration whose attacker-selected first parent resets provenance", () => {
    const { cwd, git, commit, review, sourceCommit } = sourceFixture();
    const genuinePreviousAlas = git("rev-parse", `${sourceCommit}^1`);

    git("switch", "-c", "attacker-prior", "v1.0.0");
    const forgedPreviousLedger = { version: 1, baseTag: "v1.0.0", patches: [] };
    const forgedPreviousAlas = commit("forge prior protected state", {
      "src/backdoor.ts": "export const backdoor = true;\n",
      "docs/ALAS_DOWNSTREAM_PATCHES.json": `${JSON.stringify(forgedPreviousLedger, null, 2)}\n`,
    });
    const forgedReview = { ...review, preservedCommits: [] };
    const forgedLedger = advanceLedgerBaseTag({
      ledger: forgedPreviousLedger,
      review: forgedReview,
    }).ledger;
    buildSyncCandidate({
      cwd,
      targetRef: "v1.1.0",
      alasRef: forgedPreviousAlas,
      upstreamMainRef: "upstream-main",
      branch: "forged-candidate",
      review: forgedReview,
      ledger: forgedLedger,
      allowReviewedPreserved: true,
    });
    commit("record forged sync review", {
      "docs/ALAS_SYNC_REVIEW.json": `${JSON.stringify(forgedReview, null, 2)}\n`,
      "docs/ALAS_DOWNSTREAM_PATCHES.json": `${JSON.stringify(forgedLedger, null, 2)}\n`,
    });
    const forged = buildProtectedIntegration({
      cwd,
      targetRef: "v1.1.0",
      targetTag: "v1.1.0",
      candidateRef: "HEAD",
      alasRef: forgedPreviousAlas,
      upstreamMainRef: "upstream-main",
      branch: "forged-integration",
    });

    expect(() =>
      verifySyncSourceReview({
        cwd,
        sourceCommit: forged.integrationCommit,
        priorProtectedCommit: genuinePreviousAlas,
        upstreamMainRef: "upstream-main",
        targetTag: "v1.1.0",
        review: forgedReview,
        ledger: forgedLedger,
      }),
    ).toThrow(/prior protected|first parent|provenance/i);
  });
});
