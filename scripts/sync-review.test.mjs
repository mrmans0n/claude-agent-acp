import { describe, expect, it } from "vitest";
import { format } from "prettier";
import {
  advanceLedgerBaseTag,
  createSyncReview,
  formatSyncJson,
  verifyLedgerReviewTransition,
  verifySyncReview,
} from "./sync-review.mjs";

const targetCommit = "a".repeat(40);
const patch = (name, status) => ({
  name,
  commit: status === "unaffected" ? "1".repeat(40) : "2".repeat(40),
  upstreamPr: null,
  files: [`src/${name}.ts`],
  tests: [`src/tests/${name}.test.ts`],
  status,
  equivalent: status === "absorbed",
  overlappingFiles: status === "overlap" ? [`src/${name}.ts`] : [],
});
const audit = {
  baseTag: "v1.0.0",
  targetRef: "v1.1.0",
  targetCommit,
  changedFiles: ["src/overlap.ts"],
  patches: [
    patch("safe", "unaffected"),
    patch("absorbed", "absorbed"),
    patch("overlap", "overlap"),
  ],
};
const retiredCommit = "8".repeat(40);
const retiredEntry = {
  commit: retiredCommit,
  classification: "absorbed",
  rationale: "Upstream now settles prompts folded into the task-notification cycle.",
  tests: ["src/tests/acp-agent.test.ts"],
  automatic: false,
};

describe("sync review artifact", () => {
  it.each([
    {
      version: 1,
      baseTag: "v1.0.0",
      patches: [
        {
          name: "feature-opt-in",
          commit: "1".repeat(40),
          files: ["docs/extensions.md", "src/agent.ts", "src/feature-extension.ts"],
          tests: ["src/tests/agent.test.ts", "src/tests/feature.test.ts"],
          lastResolution: {
            fromTag: "v0.9.0",
            toTag: "v1.0.0",
            originalCommit: "2".repeat(40),
            decision: "retain",
          },
        },
      ],
      retiredCommits: [],
      preservedTransitions: [],
    },
    {
      resolution: {
        decision: "retain",
        rationale: "x",
        tests: ["x"],
        automatic: false,
      },
    },
  ])("serializes generated sync JSON as a repository-formatter fixed point", async (artifact) => {
    const formatted = formatSyncJson(artifact);

    expect(JSON.parse(formatted)).toEqual(artifact);
    expect(formatted).toBe(
      await format(formatted, { parser: "json", printWidth: 100, tabWidth: 2 }),
    );
  });

  it("auto-resolves only unaffected patches and leaves absorbed and overlap unresolved", () => {
    const review = createSyncReview({ audit, preservedCommits: [] });

    expect(review).toMatchObject({
      version: 1,
      fromTag: "v1.0.0",
      toTag: "v1.1.0",
      toCommit: targetCommit,
      resolved: false,
    });
    expect(review.patches).toEqual([
      expect.objectContaining({
        name: "safe",
        classification: "unaffected",
        files: ["src/safe.ts"],
        tests: ["src/tests/safe.test.ts"],
        resolution: expect.objectContaining({ decision: "retain", automatic: true }),
      }),
      expect.objectContaining({ name: "absorbed", classification: "absorbed", resolution: null }),
      expect.objectContaining({ name: "overlap", classification: "overlap", resolution: null }),
    ]);
  });

  it("preserves explicit reviewed resolutions and verifies a recomputed audit", () => {
    const existing = createSyncReview({ audit, preservedCommits: [] });
    existing.patches[1].resolution = {
      decision: "drop",
      rationale: "Upstream now provides equivalent behavior.",
      tests: ["src/tests/absorbed.test.ts"],
      automatic: false,
    };
    existing.patches[2].resolution = {
      decision: "adapt",
      commit: "4".repeat(40),
      rationale: "Keep the opt-in API while using the new upstream contract.",
      tests: ["src/tests/overlap.test.ts"],
      automatic: false,
    };

    const review = createSyncReview({ audit, existingReview: existing, preservedCommits: [] });
    expect(review.resolved).toBe(true);
    expect(verifySyncReview({ audit, review, preservedCommits: [] })).toEqual(
      expect.objectContaining({ resolved: true }),
    );
  });

  it("rejects stale classifications and unresolved preserved sync-only commits", () => {
    const review = createSyncReview({
      audit,
      preservedCommits: [{ commit: "3".repeat(40), subject: "maintainer edit" }],
    });
    expect(review.preservedCommits).toEqual([
      expect.objectContaining({ commit: "3".repeat(40), resolution: null }),
    ]);
    expect(() => verifySyncReview({ audit, review, preservedCommits: [] })).toThrow(/preserved/i);
    expect(() =>
      verifySyncReview({
        audit: { ...audit, patches: [patch("safe", "overlap"), ...audit.patches.slice(1)] },
        review,
        preservedCommits: [{ commit: "3".repeat(40), subject: "maintainer edit" }],
      }),
    ).toThrow(/classification|audit/i);
  });

  it("retains an explicit reviewed resolution for a preserved sync-only commit", () => {
    const safeAudit = { ...audit, patches: [patch("safe", "unaffected")] };
    const preservedCommits = [{ commit: "3".repeat(40), subject: "maintainer edit" }];
    const existing = createSyncReview({ audit: safeAudit, preservedCommits });
    existing.preservedCommits[0].resolution = {
      decision: "retain",
      rationale: "The edit updates downstream documentation for the new stable API.",
      tests: ["npm run test:run"],
      automatic: false,
    };

    const review = createSyncReview({
      audit: safeAudit,
      existingReview: existing,
      preservedCommits,
    });
    expect(review.resolved).toBe(true);
    expect(review.preservedCommits[0]).toEqual(
      expect.objectContaining({
        classification: "preserved-sync-edit",
        resolution: expect.objectContaining({ decision: "retain", automatic: false }),
      }),
    );
  });

  it("preserves valid manual retirements only for the same sync range", () => {
    const safeAudit = { ...audit, patches: [patch("safe", "unaffected")] };
    const existing = createSyncReview({ audit: safeAudit, preservedCommits: [] });
    existing.retiredCommits = [retiredEntry];

    const sameRange = createSyncReview({
      audit: safeAudit,
      existingReview: existing,
      preservedCommits: [],
    });
    expect(sameRange.retiredCommits).toEqual([retiredEntry]);
    expect(sameRange.resolved).toBe(true);

    const nextRange = createSyncReview({
      audit: {
        ...safeAudit,
        baseTag: "v1.1.0",
        targetRef: "v1.2.0",
        targetCommit: "b".repeat(40),
      },
      existingReview: {
        ...existing,
        retiredCommits: [{ ...retiredEntry, rationale: "" }],
      },
      preservedCommits: [],
    });
    expect(nextRange.retiredCommits).toEqual([]);
  });

  it.each([
    ["a short commit", { ...retiredEntry, commit: "8".repeat(39) }],
    ["an unsupported classification", { ...retiredEntry, classification: "obsolete" }],
    ["an empty rationale", { ...retiredEntry, rationale: "   " }],
    ["missing tests", { ...retiredEntry, tests: [] }],
    ["an automatic decision", { ...retiredEntry, automatic: true }],
  ])("rejects a resolved review containing %s", (_description, invalidEntry) => {
    const safeAudit = { ...audit, patches: [patch("safe", "unaffected")] };
    const review = createSyncReview({ audit: safeAudit, preservedCommits: [] });
    review.retiredCommits = [invalidEntry];
    review.resolved = true;

    expect(() =>
      createSyncReview({ audit: safeAudit, existingReview: review, preservedCommits: [] }),
    ).toThrow(/retired/i);
    expect(() => verifySyncReview({ audit: safeAudit, review, preservedCommits: [] })).toThrow(
      /retired|resolved/i,
    );
  });

  it("verifies manual retirements while accepting older reviews that omit the field", () => {
    const safeAudit = { ...audit, patches: [patch("safe", "unaffected")] };
    const legacyReview = createSyncReview({ audit: safeAudit, preservedCommits: [] });
    delete legacyReview.retiredCommits;
    expect(
      verifySyncReview({ audit: safeAudit, review: legacyReview, preservedCommits: [] }),
    ).toEqual(expect.objectContaining({ resolved: true, retiredCommits: [] }));

    const existing = { ...legacyReview, retiredCommits: [retiredEntry] };
    const review = createSyncReview({
      audit: safeAudit,
      existingReview: existing,
      preservedCommits: [],
    });
    expect(verifySyncReview({ audit: safeAudit, review, preservedCommits: [] })).toEqual(
      expect.objectContaining({ retiredCommits: [retiredEntry], resolved: true }),
    );
  });

  it("rejects an adapt resolution without a replacement commit", () => {
    const existing = createSyncReview({ audit, preservedCommits: [] });
    existing.patches[1].resolution = {
      decision: "drop",
      rationale: "Upstream supplies equivalent behavior.",
      tests: ["src/tests/absorbed.test.ts"],
      automatic: false,
    };
    existing.patches[2].resolution = {
      decision: "adapt",
      rationale: "Adapt to the changed upstream contract.",
      tests: ["src/tests/overlap.test.ts"],
      automatic: false,
    };

    const review = createSyncReview({ audit, existingReview: existing, preservedCommits: [] });
    expect(review.resolved).toBe(false);
    expect(review.patches[2].resolution).toBeNull();
  });

  it("advances the ledger only for a resolved review and is a no-op on the second rerun", () => {
    const resolvedReview = createSyncReview({
      audit: { ...audit, patches: [patch("safe", "unaffected")] },
      preservedCommits: [],
    });
    const ledger = {
      version: 1,
      baseTag: "v1.0.0",
      patches: [
        {
          name: "safe",
          commit: "1".repeat(40),
          upstreamPr: null,
          files: ["src/safe.ts"],
          tests: ["src/tests/safe.test.ts"],
        },
      ],
    };

    const first = advanceLedgerBaseTag({ ledger, review: resolvedReview });
    expect(first.changed).toBe(true);
    expect(verifyLedgerReviewTransition({ ledger: first.ledger, review: resolvedReview })).toBe(
      true,
    );
    expect(advanceLedgerBaseTag({ ledger: first.ledger, review: resolvedReview })).toEqual({
      changed: false,
      ledger: first.ledger,
    });

    const unresolvedReview = createSyncReview({ audit, preservedCommits: [] });
    expect(() => advanceLedgerBaseTag({ ledger, review: unresolvedReview })).toThrow(/unresolved/i);
  });

  it("records dropped and adapted patch state when advancing the ledger", () => {
    const existing = createSyncReview({ audit, preservedCommits: [] });
    existing.patches[1].resolution = {
      decision: "drop",
      rationale: "Upstream supplies the behavior.",
      tests: ["src/tests/absorbed.test.ts"],
      automatic: false,
    };
    existing.patches[2].resolution = {
      decision: "adapt",
      commit: "4".repeat(40),
      rationale: "Use the new upstream contract.",
      tests: ["src/tests/overlap.test.ts"],
      automatic: false,
    };
    const review = createSyncReview({ audit, existingReview: existing, preservedCommits: [] });
    const ledger = {
      version: 1,
      baseTag: "v1.0.0",
      patches: audit.patches.map(
        ({ status: _status, equivalent: _equivalent, overlappingFiles: _paths, ...entry }) => entry,
      ),
    };

    const result = advanceLedgerBaseTag({ ledger, review });
    expect(result.ledger.patches).toEqual([
      expect.objectContaining({ name: "safe", disposition: "active" }),
      expect.objectContaining({
        name: "absorbed",
        disposition: "dropped",
        retiredCommits: ["2".repeat(40)],
      }),
      expect.objectContaining({
        name: "overlap",
        commit: "4".repeat(40),
        disposition: "active",
        retiredCommits: ["2".repeat(40)],
      }),
    ]);
    expect(verifyLedgerReviewTransition({ ledger: result.ledger, review })).toBe(true);
    expect(
      verifyLedgerReviewTransition({ ledger: result.ledger, review, previousLedger: ledger }),
    ).toBe(true);
    const coordinatedOmissionReview = {
      ...review,
      patches: review.patches.filter((patch) => patch.name !== "safe"),
    };
    const coordinatedOmissionLedger = {
      ...result.ledger,
      patches: result.ledger.patches.filter((patch) => patch.name !== "safe"),
    };
    expect(() =>
      verifyLedgerReviewTransition({
        ledger: coordinatedOmissionLedger,
        review: coordinatedOmissionReview,
        previousLedger: ledger,
      }),
    ).toThrow(/exactly match|active patch/i);
    const missingRetirement = structuredClone(result.ledger);
    missingRetirement.patches.find((patch) => patch.name === "overlap").retiredCommits = [];
    expect(() => verifyLedgerReviewTransition({ ledger: missingRetirement, review })).toThrow(
      /retired/i,
    );
    const tampered = structuredClone(review);
    tampered.patches[0].files = ["src/omitted.ts"];
    expect(() => verifyLedgerReviewTransition({ ledger: result.ledger, review: tampered })).toThrow(
      /metadata/i,
    );
    const omitted = { ...review, patches: review.patches.filter((patch) => patch.name !== "safe") };
    expect(() => verifyLedgerReviewTransition({ ledger: result.ledger, review: omitted })).toThrow(
      /active ledger patch|transition/i,
    );
  });

  it("persists preserved drop and adapt decisions for later syncs", () => {
    const safeAudit = { ...audit, patches: [patch("safe", "unaffected")] };
    const preservedCommits = [
      { commit: "5".repeat(40), subject: "drop edit" },
      { commit: "6".repeat(40), subject: "adapt edit" },
    ];
    const existing = createSyncReview({ audit: safeAudit, preservedCommits });
    existing.preservedCommits[0].resolution = {
      decision: "drop",
      rationale: "The edit is obsolete.",
      tests: ["npm run test:run"],
      automatic: false,
    };
    existing.preservedCommits[1].resolution = {
      decision: "adapt",
      commit: "7".repeat(40),
      rationale: "Use the replacement edit.",
      tests: ["npm run test:run"],
      automatic: false,
    };
    const review = createSyncReview({
      audit: safeAudit,
      existingReview: existing,
      preservedCommits,
    });
    const ledger = {
      version: 1,
      baseTag: "v1.0.0",
      patches: [
        {
          name: "safe",
          commit: "1".repeat(40),
          upstreamPr: null,
          files: ["src/safe.ts"],
          tests: ["src/tests/safe.test.ts"],
        },
      ],
    };

    const result = advanceLedgerBaseTag({ ledger, review });
    expect(result.ledger.retiredCommits).toEqual(["5".repeat(40), "6".repeat(40)]);
    expect(result.ledger.preservedTransitions).toEqual([
      expect.objectContaining({ commit: "5".repeat(40), decision: "drop" }),
      expect.objectContaining({
        commit: "6".repeat(40),
        decision: "adapt",
        replacementCommit: "7".repeat(40),
      }),
    ]);
    expect(verifyLedgerReviewTransition({ ledger: result.ledger, review })).toBe(true);
  });

  it("durably records manual retirements and verifies their exact ledger transition", () => {
    const safeAudit = { ...audit, patches: [patch("safe", "unaffected")] };
    const existing = createSyncReview({ audit: safeAudit, preservedCommits: [] });
    existing.retiredCommits = [retiredEntry];
    const review = createSyncReview({
      audit: safeAudit,
      existingReview: existing,
      preservedCommits: [],
    });
    const ledger = {
      version: 1,
      baseTag: "v1.0.0",
      patches: [
        {
          name: "safe",
          commit: "1".repeat(40),
          upstreamPr: null,
          files: ["src/safe.ts"],
          tests: ["src/tests/safe.test.ts"],
        },
      ],
      retiredCommits: ["9".repeat(40)],
    };

    const result = advanceLedgerBaseTag({ ledger, review });
    expect(result.ledger.retiredCommits).toEqual(["9".repeat(40), retiredCommit]);
    expect(
      verifyLedgerReviewTransition({ ledger: result.ledger, review, previousLedger: ledger }),
    ).toBe(true);

    const omitted = structuredClone(result.ledger);
    omitted.retiredCommits = omitted.retiredCommits.filter((commit) => commit !== retiredCommit);
    expect(() =>
      verifyLedgerReviewTransition({ ledger: omitted, review, previousLedger: ledger }),
    ).toThrow(/exactly match|retired/i);

    const invented = structuredClone(result.ledger);
    invented.retiredCommits.push("7".repeat(40));
    expect(() =>
      verifyLedgerReviewTransition({ ledger: invented, review, previousLedger: ledger }),
    ).toThrow(/exactly match|retired/i);
  });
});
