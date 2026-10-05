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
    expect(ledger.patches[0].upstreamPr).toBe(1245);
  });
});

describe("sync workflow hardening", () => {
  it("does not depend on GitHub Issues", () => {
    expect(sync).not.toMatch(/issues:\s*write/);
    expect(sync).not.toMatch(/gh issue/);
  });

  it("builds an exact-tag candidate, audits patches, and leaves manual work in a draft PR", () => {
    expect(sync).toContain("scripts/audit-downstream-patches.mjs");
    expect(sync).toContain("scripts/build-sync-candidate.mjs");
    expect(sync).toContain("--draft");
    expect(sync).toContain("$GITHUB_STEP_SUMMARY");
    expect(sync).toContain("--force-with-lease=refs/heads/$BRANCH:$EXPECTED_BRANCH_HEAD");
    expect(sync).toContain("/tmp/alas-sync-expected-heads.tsv");
    expect(sync).toContain("Concurrent sync-branch update detected");
  });
});

describe("publish workflow hardening", () => {
  it("pins checkout and setup-node to the sync workflow SHAs", () => {
    expect(publish.match(new RegExp(`actions/checkout@${checkoutSha}`, "g"))).toHaveLength(2);
    expect(publish).toContain(`actions/setup-node@${setupNodeSha}`);
    expect(publish).not.toMatch(/actions\/(checkout|setup-node)@v\d/);
  });

  it("requires a declared stable tag and exact upstream merge-base verification", () => {
    expect(publish).toMatch(/upstream_tag:/);
    expect(publish).toContain("scripts/verify-alas-source.mjs");
    expect(publish).toContain("refs/remotes/alas-upstream/main");
  });
});
