import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sync = readFileSync(
  new URL("../.github/workflows/sync-upstream.yml", import.meta.url),
  "utf8",
);
const publish = readFileSync(
  new URL("../.github/workflows/publish-alas.yml", import.meta.url),
  "utf8",
);
const ledger = JSON.parse(
  readFileSync(new URL("../docs/ALAS_DOWNSTREAM_PATCHES.json", import.meta.url), "utf8"),
);
const review = JSON.parse(
  readFileSync(new URL("../docs/ALAS_SYNC_REVIEW.json", import.meta.url), "utf8"),
);
const downstreamDocs = readFileSync(new URL("../docs/ALAS_DOWNSTREAM.md", import.meta.url), "utf8");

const checkoutSha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNodeSha = "820762786026740c76f36085b0efc47a31fe5020";

describe("downstream patch ledger", () => {
  it("records the two functional patches with review metadata", () => {
    expect(ledger.version).toBe(1);
    expect(ledger.baseTag).toBe("v0.85.1");
    expect(ledger.patches.map((patch) => patch.name)).toEqual([
      "goal-capability-opt-in",
      "async-tasks-opt-in",
    ]);
    for (const patch of ledger.patches) {
      expect(patch.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(patch).toHaveProperty("upstreamPr");
      expect(patch.files.length).toBeGreaterThan(0);
      expect(patch.tests.length).toBeGreaterThan(0);
    }
    expect(ledger.patches[0]).toMatchObject({
      upstreamPr: 1245,
      identityCommit: "60749d07ff50308ef96c5251152a8d4986fe680f",
    });
    expect(ledger.patches[1].identityCommit).toBe("3e098c71628cc7d5927ee8a3d794faa433dce12d");
  });

  it("commits a versioned sync review consistent with the ledger state", () => {
    expect(review.version).toBe(1);
    expect(review.toTag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(review.resolved).toBeTypeOf("boolean");
    expect([review.fromTag, review.toTag]).toContain(ledger.baseTag);
    if (ledger.baseTag === review.toTag) expect(review.resolved).toBe(true);
    expect(review.toCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(review.patches.map((patch) => patch.name)).toEqual(
      ledger.patches.map((patch) => patch.name),
    );
  });
});

describe("sync workflow hardening", () => {
  it("does not depend on GitHub Issues", () => {
    expect(sync).not.toMatch(/issues:\s*write/);
    expect(sync).not.toMatch(/gh issue/);
  });

  it("verifies release agreement before building a protected-branch integration PR", () => {
    expect(sync).toContain("scripts/verify-upstream-release.mjs");
    expect(sync).toContain("releases/tags/$TAG");
    expect(sync).toContain("@agentclientprotocol%2Fclaude-agent-acp");
    expect(sync).toContain("scripts/audit-downstream-patches.mjs");
    expect(sync).toContain("scripts/sync-review.mjs");
    expect(sync).toContain("scripts/build-sync-candidate.mjs");
    expect(sync).toContain("current-ledger.json");
    expect(sync).toContain("--mode integration");
    expect(sync).toContain("gh pr ready");
    expect(sync).toContain("$GITHUB_STEP_SUMMARY");
    expect(sync).toContain("--force-with-lease=refs/heads/$BRANCH:$EXPECTED_BRANCH_HEAD");
    expect(sync).toContain("git diff --cached --quiet");
    expect(sync).toContain("GIT_COMMITTER_DATE");
    expect(sync).toContain("existing-review.json");
    expect(sync).toContain("provenance_args");
    expect(sync).toContain("preserved.at(-1)?.commit");
    expect(sync).toMatch(/if:\s*\$\{\{ always\(\) \}\}/);
    expect(sync).toContain("Update existing draft PR after failure");
    expect(sync).not.toContain("--force-with-lease=refs/heads/alas");
    expect(sync).not.toContain("Do not merge this PR normally");
  });
});

describe("publish workflow hardening", () => {
  it("pins checkout and setup-node to the sync workflow SHAs", () => {
    expect(publish.match(new RegExp(`actions/checkout@${checkoutSha}`, "g"))).toHaveLength(2);
    expect(publish).toContain(`actions/setup-node@${setupNodeSha}`);
    expect(publish).not.toMatch(/actions\/(checkout|setup-node)@v\d/);
  });

  it("requires upstream release agreement, exact merge-base, and a resolved sync review", () => {
    expect(publish).toMatch(/upstream_tag:/);
    expect(publish).toContain("scripts/verify-upstream-release.mjs");
    expect(publish).toContain("scripts/verify-alas-source.mjs");
    expect(publish).toContain("scripts/sync-review.mjs");
    expect(publish).toContain("--advanced-ledger docs/ALAS_DOWNSTREAM_PATCHES.json");
    expect(publish).toContain('--previous-ledger "$REPORT_DIR/review-ledger.json"');
    expect(publish).toContain("scripts/verify-sync-source-review.mjs");
    expect(publish).toContain("--prior-protected-commit");
    expect(publish).toContain("--ledger docs/ALAS_DOWNSTREAM_PATCHES.json");
    expect(publish).toContain("--target-ref refs/alas-upstream-tag");
    expect(publish).toContain("docs/ALAS_SYNC_REVIEW.json");
    expect(publish).toContain("refs/remotes/alas-upstream/main");
    expect(publish).toMatch(/if:\s*\$\{\{ always\(\) \}\}/);
  });

  it("reads npm, tag, and release state back and verifies exact publication provenance", () => {
    expect(publish).toContain("scripts/verify-alas-publication.mjs");
    expect(publish).toContain("--mode npm");
    expect(publish).toContain("--mode github");
    expect(publish).toContain("dist.attestations");
    expect(publish).toContain("npm audit signatures");
    expect(publish).toContain("--include-attestations");
    expect(publish).toContain("attestation-readback.json");
    expect(publish).toContain("expected-workflow-ref");
    expect(publish).toContain("npm pack --json");
    expect(publish).toContain("git/ref/tags/$tag");
    expect(publish).toContain("releases/tags/$tag");
    expect(publish).toContain("alreadyPublished != 'true'");
  });

  it("supports idempotent reruns after npm has published the requested source", () => {
    expect(publish).toContain("selectPublicationAnchor");
    expect(publish).toContain("excludedVersions");
    expect(publish).toContain("partial_version");
    expect(publish).toContain('git merge-base --is-ancestor "$partial_source" "$SOURCE_COMMIT"');
    expect(publish).toContain('prior_requires_latest="false"');
    expect(publish).toContain('--require-latest "$prior_requires_latest"');
    expect(publish).toContain("const maxAttempts = 60");
    expect(publish).toContain("attempt === maxAttempts - 1");
    expect(publish).toContain("const attestationMaxAttempts = 60");
    expect(publish).toContain("attestationAttempt === attestationMaxAttempts - 1");
  });
});

describe("protected branch documentation", () => {
  it("never instructs maintainers to force-push or bypass alas protection", () => {
    expect(downstreamDocs).not.toMatch(/force(?:-with-lease)?[^\n]*alas/i);
    expect(downstreamDocs).not.toMatch(/bypass/i);
    expect(downstreamDocs).not.toContain("Do not merge the PR through GitHub's merge button");
  });
});
