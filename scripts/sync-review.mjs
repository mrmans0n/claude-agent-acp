import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[0-9a-f]{40}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DECISIONS = new Set(["retain", "adapt", "drop"]);

function manualResolutionValid(resolution) {
  return (
    resolution !== null &&
    typeof resolution === "object" &&
    DECISIONS.has(resolution.decision) &&
    (resolution.decision !== "adapt" || COMMIT.test(resolution.commit ?? "")) &&
    resolution.automatic === false &&
    typeof resolution.rationale === "string" &&
    resolution.rationale.trim().length > 0 &&
    Array.isArray(resolution.tests) &&
    resolution.tests.length > 0 &&
    resolution.tests.every((test) => typeof test === "string" && test.length > 0)
  );
}

function automaticResolution(patch) {
  return {
    decision: "retain",
    rationale: "No equivalent upstream patch or overlapping path was detected.",
    tests: [...patch.tests],
    automatic: true,
  };
}

function retainedManualResolution(existing, classification) {
  if (existing?.classification !== classification) return null;
  return manualResolutionValid(existing.resolution) ? existing.resolution : null;
}

function reviewResolved(review) {
  return (
    review.patches.every((patch) =>
      patch.classification === "unaffected"
        ? patch.resolution?.automatic === true
        : manualResolutionValid(patch.resolution),
    ) && review.preservedCommits.every((entry) => manualResolutionValid(entry.resolution))
  );
}

export function createSyncReview({ audit, existingReview, preservedCommits = [] }) {
  if (!TAG.test(audit?.baseTag ?? "") || !TAG.test(audit?.targetRef ?? "")) {
    throw new Error("Audit must identify stable fromTag and toTag values");
  }
  if (!COMMIT.test(audit?.targetCommit ?? "")) {
    throw new Error("Audit must identify the target tag commit");
  }
  const sameRange =
    existingReview?.fromTag === audit.baseTag &&
    existingReview?.toTag === audit.targetRef &&
    existingReview?.toCommit === audit.targetCommit;
  const existingPatches = new Map(
    sameRange ? (existingReview.patches ?? []).map((patch) => [patch.name, patch]) : [],
  );
  const existingPreserved = new Map(
    sameRange ? (existingReview.preservedCommits ?? []).map((entry) => [entry.commit, entry]) : [],
  );
  const patches = audit.patches.map((patch) => ({
    name: patch.name,
    commit: patch.commit,
    upstreamPr: patch.upstreamPr,
    files: [...patch.files],
    tests: [...patch.tests],
    classification: patch.status,
    equivalent: patch.equivalent,
    overlappingFiles: [...patch.overlappingFiles],
    resolution:
      patch.status === "unaffected"
        ? automaticResolution(patch)
        : retainedManualResolution(existingPatches.get(patch.name), patch.status),
  }));
  const preserved = preservedCommits.map((entry) => ({
    commit: entry.commit,
    subject: entry.subject,
    constituentCommits: [...(entry.constituentCommits ?? [])],
    classification: "preserved-sync-edit",
    resolution: retainedManualResolution(
      existingPreserved.get(entry.commit),
      "preserved-sync-edit",
    ),
  }));
  const review = {
    version: 1,
    fromTag: audit.baseTag,
    toTag: audit.targetRef,
    toCommit: audit.targetCommit,
    patches,
    preservedCommits: preserved,
    resolved: false,
  };
  review.resolved = reviewResolved(review);
  return review;
}

export function verifySyncReview({ audit, review, preservedCommits = [] }) {
  const expected = createSyncReview({ audit, existingReview: review, preservedCommits });
  if (review?.version !== 1) throw new Error("Sync review version must be 1");
  for (const key of ["fromTag", "toTag", "toCommit"]) {
    if (review[key] !== expected[key])
      throw new Error(`Sync review ${key} does not match the audit`);
  }
  if (JSON.stringify(review.patches) !== JSON.stringify(expected.patches)) {
    throw new Error(
      "Sync review patch classification or resolution does not match the recomputed audit",
    );
  }
  if (JSON.stringify(review.preservedCommits ?? []) !== JSON.stringify(expected.preservedCommits)) {
    throw new Error("Sync review preserved sync edits do not match the candidate");
  }
  if (review.resolved !== expected.resolved) {
    throw new Error("Sync review resolved flag does not match its resolutions");
  }
  if (!expected.resolved) throw new Error("Sync review contains unresolved manual-review items");
  return expected;
}

function expectedLedgerTransition(review, patch) {
  return {
    fromTag: review.fromTag,
    toTag: review.toTag,
    originalCommit: patch.commit,
    decision: patch.resolution.decision,
    ...(patch.resolution.decision === "adapt"
      ? { replacementCommit: patch.resolution.commit }
      : {}),
  };
}

function expectedPreservedTransition(review, entry) {
  return {
    fromTag: review.fromTag,
    toTag: review.toTag,
    commit: entry.commit,
    constituentCommits: [...(entry.constituentCommits ?? [])],
    decision: entry.resolution.decision,
    ...(entry.resolution.decision === "adapt"
      ? { replacementCommit: entry.resolution.commit }
      : {}),
  };
}

export function verifyLedgerReviewTransition({ ledger, review, previousLedger }) {
  if (!review?.resolved) throw new Error("Cannot verify an unresolved sync review transition");
  if (ledger?.baseTag !== review.toTag) {
    throw new Error(
      `Patch ledger baseTag ${ledger?.baseTag} does not match review toTag ${review.toTag}`,
    );
  }
  if (previousLedger) {
    if (previousLedger.baseTag !== review.fromTag) {
      throw new Error("Previous ledger baseTag does not match the sync review");
    }
    const previousActive = previousLedger.patches.filter(
      (patch) => patch.disposition !== "dropped",
    );
    if (previousActive.length !== review.patches.length) {
      throw new Error("Previous ledger active patch set does not match the sync review");
    }
    for (const previous of previousActive) {
      const patch = review.patches.find((candidate) => candidate.name === previous.name);
      if (!patch || patch.commit !== previous.commit) {
        throw new Error(`Previous ledger patch ${previous.name} is missing from the sync review`);
      }
      for (const key of ["upstreamPr", "files", "tests"]) {
        if (JSON.stringify(previous[key]) !== JSON.stringify(patch[key])) {
          throw new Error(
            `Previous ledger metadata for ${previous.name} does not match the review`,
          );
        }
      }
    }
    for (const commit of previousLedger.retiredCommits ?? []) {
      if (!(ledger.retiredCommits ?? []).includes(commit)) {
        throw new Error(`Previous ledger retirement ${commit} was removed`);
      }
    }
    for (const transition of previousLedger.preservedTransitions ?? []) {
      if (
        !(ledger.preservedTransitions ?? []).some(
          (entry) => JSON.stringify(entry) === JSON.stringify(transition),
        )
      ) {
        throw new Error("Previous ledger preserved transition was removed");
      }
    }
  }
  const reviewed = new Map(review.patches.map((patch) => [patch.name, patch]));
  for (const patch of review.patches) {
    const entry = ledger.patches.find((candidate) => candidate.name === patch.name);
    if (!entry) throw new Error(`Patch ledger is missing reviewed patch ${patch.name}`);
    for (const key of ["upstreamPr", "files", "tests"]) {
      if (JSON.stringify(entry[key]) !== JSON.stringify(patch[key])) {
        throw new Error(`Patch ledger metadata for ${patch.name} does not match the sync review`);
      }
    }
    const expected = expectedLedgerTransition(review, patch);
    if (JSON.stringify(entry.lastResolution) !== JSON.stringify(expected)) {
      throw new Error(`Patch ledger transition for ${patch.name} does not match the sync review`);
    }
    if (patch.resolution.decision === "drop") {
      if (entry.disposition !== "dropped" || !(entry.retiredCommits ?? []).includes(patch.commit)) {
        throw new Error(`Dropped patch ${patch.name} is not retired in the patch ledger`);
      }
    } else {
      const expectedCommit =
        patch.resolution.decision === "adapt" ? patch.resolution.commit : patch.commit;
      if (entry.disposition !== "active" || entry.commit !== expectedCommit) {
        throw new Error(`Active patch ${patch.name} does not match its reviewed resolution`);
      }
      if (
        patch.resolution.decision === "adapt" &&
        !(entry.retiredCommits ?? []).includes(patch.commit)
      ) {
        throw new Error(`Adapted patch ${patch.name} original commit is not retired`);
      }
    }
  }
  for (const entry of ledger.patches) {
    if (entry.disposition === "active" && !reviewed.has(entry.name)) {
      throw new Error(`Active ledger patch ${entry.name} is missing from the sync review`);
    }
    if (entry.lastResolution?.toTag === review.toTag && !reviewed.has(entry.name)) {
      throw new Error(`Patch ledger transition ${entry.name} is missing from the sync review`);
    }
  }
  const expectedPreserved = review.preservedCommits.map((entry) =>
    expectedPreservedTransition(review, entry),
  );
  const actualPreserved = (ledger.preservedTransitions ?? []).filter(
    (entry) => entry.toTag === review.toTag,
  );
  if (JSON.stringify(actualPreserved) !== JSON.stringify(expectedPreserved)) {
    throw new Error("Patch ledger preserved-edit transitions do not match the sync review");
  }
  for (const entry of review.preservedCommits) {
    if (["drop", "adapt"].includes(entry.resolution.decision)) {
      for (const commit of [entry.commit, ...(entry.constituentCommits ?? [])]) {
        if (!(ledger.retiredCommits ?? []).includes(commit)) {
          throw new Error(`Preserved edit ${commit} is not durably retired`);
        }
      }
    }
  }
  return true;
}

export function advanceLedgerBaseTag({ ledger, review }) {
  if (!review?.resolved)
    throw new Error("Cannot advance the patch ledger from an unresolved review");
  if (ledger.baseTag === review.toTag) {
    verifyLedgerReviewTransition({ ledger, review });
    return { changed: false, ledger };
  }
  if (ledger.baseTag !== review.fromTag) {
    throw new Error(
      `Patch ledger baseTag ${ledger.baseTag} does not match review fromTag ${review.fromTag}`,
    );
  }
  const reviewedPatches = new Map(review.patches.map((patch) => [patch.name, patch]));
  for (const reviewed of review.patches) {
    const current = ledger.patches.find((patch) => patch.name === reviewed.name);
    if (!current || current.commit !== reviewed.commit) {
      throw new Error(`Patch ledger does not contain reviewed commit ${reviewed.commit}`);
    }
  }
  const patches = ledger.patches.map((patch) => {
    const reviewed = reviewedPatches.get(patch.name);
    if (!reviewed || reviewed.commit !== patch.commit) return patch;
    const decision = reviewed.resolution.decision;
    const lastResolution = expectedLedgerTransition(review, reviewed);
    if (decision === "drop") {
      return {
        ...patch,
        disposition: "dropped",
        retiredCommits: [...new Set([...(patch.retiredCommits ?? []), patch.commit])],
        lastResolution,
      };
    }
    if (decision === "adapt") {
      return {
        ...patch,
        commit: reviewed.resolution.commit,
        disposition: "active",
        retiredCommits: [...new Set([...(patch.retiredCommits ?? []), patch.commit])],
        lastResolution,
      };
    }
    return { ...patch, disposition: "active", lastResolution };
  });
  const preservedTransitions = [
    ...(ledger.preservedTransitions ?? []).filter((entry) => entry.toTag !== review.toTag),
    ...review.preservedCommits.map((entry) => expectedPreservedTransition(review, entry)),
  ];
  const retiredCommits = [
    ...new Set([
      ...(ledger.retiredCommits ?? []),
      ...review.preservedCommits
        .filter((entry) => ["drop", "adapt"].includes(entry.resolution.decision))
        .flatMap((entry) => [entry.commit, ...(entry.constituentCommits ?? [])]),
    ]),
  ];
  const advanced = {
    ...ledger,
    baseTag: review.toTag,
    patches,
    retiredCommits,
    preservedTransitions,
  };
  verifyLedgerReviewTransition({ ledger: advanced, review });
  return { changed: true, ledger: advanced };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const audit = readJson(args.audit);
  const reviewPath = resolve(args.review);
  const preservedCommits = args.preserved ? readJson(args.preserved) : [];
  if (args.mode === "generate") {
    const existingReview = existsSync(reviewPath) ? readJson(reviewPath) : undefined;
    const review = createSyncReview({ audit, existingReview, preservedCommits });
    writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
  } else if (args.mode === "verify") {
    const review = readJson(reviewPath);
    verifySyncReview({ audit, review, preservedCommits });
    if (args["advanced-ledger"]) {
      verifyLedgerReviewTransition({
        ledger: readJson(args["advanced-ledger"]),
        review,
        previousLedger: args["previous-ledger"] ? readJson(args["previous-ledger"]) : undefined,
      });
    }
    if (args.ledger) {
      const ledgerPath = resolve(args.ledger);
      const result = advanceLedgerBaseTag({ ledger: readJson(ledgerPath), review });
      if (result.changed) writeFileSync(ledgerPath, `${JSON.stringify(result.ledger, null, 2)}\n`);
      process.stdout.write(
        `${JSON.stringify({ resolved: true, ledgerChanged: result.changed })}\n`,
      );
    } else {
      process.stdout.write(
        `${JSON.stringify({ resolved: true, ledgerVerified: Boolean(args["advanced-ledger"]) })}\n`,
      );
    }
  } else {
    throw new Error(`Unsupported --mode ${args.mode}`);
  }
}
