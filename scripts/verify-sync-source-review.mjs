import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaudePatchIdentities } from "./audit-downstream-patches.mjs";
import {
  buildSyncCandidate,
  createProtectedIntegrationCommit,
  discoverCanonicalPreservedCommits,
  recordSyncReviewState,
} from "./build-sync-candidate.mjs";
import { verifyLedgerReviewTransition } from "./sync-review.mjs";

const LEDGER_PATH = "docs/ALAS_DOWNSTREAM_PATCHES.json";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function integrationShapeValid(cwd, commit, targetTag, targetCommit, upstreamMainRef) {
  const expected = `chore: integrate upstream ${targetTag}`;
  const subject = git(cwd, "show", "-s", "--format=%s", commit);
  const parents = git(cwd, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
  const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
  return (
    subject === expected &&
    parents.length >= 2 &&
    git(cwd, "show", "-s", "--format=%ae%n%ce", commit) === `${botEmail}\n${botEmail}` &&
    git(cwd, "rev-parse", `${commit}^{tree}`) === git(cwd, "rev-parse", `${parents[1]}^{tree}`) &&
    git(cwd, "merge-base", commit, upstreamMainRef) === targetCommit
  );
}

function isFirstParentAncestor(cwd, ancestor, descendant) {
  return git(cwd, "rev-list", "--first-parent", descendant).split("\n").includes(ancestor);
}

function findIntegrationCommit(
  cwd,
  sourceCommit,
  priorProtectedCommit,
  targetTag,
  targetCommit,
  upstreamMainRef,
) {
  if (integrationShapeValid(cwd, sourceCommit, targetTag, targetCommit, upstreamMainRef)) {
    return sourceCommit;
  }
  const parents = git(cwd, "rev-list", "--parents", "-n", "1", sourceCommit).split(" ").slice(1);
  if (
    priorProtectedCommit &&
    parents.length === 2 &&
    isFirstParentAncestor(cwd, priorProtectedCommit, parents[0]) &&
    integrationShapeValid(cwd, parents[1], targetTag, targetCommit, upstreamMainRef) &&
    git(cwd, "rev-parse", `${parents[1]}^1`) === parents[0] &&
    git(cwd, "rev-parse", `${sourceCommit}^{tree}`) ===
      git(cwd, "rev-parse", `${parents[1]}^{tree}`)
  ) {
    return parents[1];
  }
  throw new Error(
    `Publication source is neither the exact reviewed ${targetTag} integration nor a tree-identical protected-branch merge wrapper`,
  );
}

function verifyPreservedReferences(cwd, sourceCommit, review) {
  for (const entry of review.preservedCommits ?? []) {
    const commit = git(cwd, "rev-parse", `${entry.commit}^{commit}`);
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", commit, sourceCommit], {
      cwd,
    });
    if (ancestor.status !== 0) {
      throw new Error(`Preserved sync commit ${commit} is not in the canonical source ancestry`);
    }
    const subject = git(cwd, "show", "-s", "--format=%s", commit);
    if (subject !== entry.subject) {
      throw new Error(`Preserved sync commit ${commit} subject does not match the review`);
    }
  }
}

function readPreviousLedger(cwd, previousAlas) {
  let contents;
  try {
    contents = git(cwd, "show", `${previousAlas}:${LEDGER_PATH}`);
  } catch {
    throw new Error(`Cannot read the previous patch ledger from ${previousAlas}:${LEDGER_PATH}`);
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Previous patch ledger at ${previousAlas}:${LEDGER_PATH} is not valid JSON`);
  }
}

function preservedIdentity(entry) {
  return {
    commit: entry.commit,
    subject: entry.subject,
    constituentCommits: [...(entry.constituentCommits ?? [])],
  };
}

function verifyCompleteCanonicalPreservedCommits({
  cwd,
  sourceCommit,
  previousAlas,
  upstreamMainRef,
  targetCommit,
  targetTag,
  review,
}) {
  const canonical = discoverCanonicalPreservedCommits({
    cwd,
    canonicalSyncRef: sourceCommit,
    alasRef: previousAlas,
    upstreamMainRef,
    targetCommit,
    targetTag,
  });
  const expected = canonical.map(preservedIdentity);
  const actual = (review.preservedCommits ?? []).map(preservedIdentity);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Sync review canonical preserved sync edits do not exactly match source history: expected ${expected.map((entry) => entry.commit).join(", ") || "none"}; received ${actual.map((entry) => entry.commit).join(", ") || "none"}`,
    );
  }
  return canonical;
}

function sourceTreeMatchesCandidate(cwd, sourceCommit, candidateCommit) {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--quiet",
      candidateCommit,
      sourceCommit,
      "--",
      ".",
      ":(exclude)docs/ALAS_SYNC_REVIEW.json",
      ":(exclude)docs/ALAS_DOWNSTREAM_PATCHES.json",
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status === 0) return;
  if (result.status === 1) {
    throw new Error("Publication source tree does not match the reviewed sync resolutions");
  }
  throw new Error(`Cannot compare publication source tree: ${result.stderr.trim()}`);
}

export function verifySyncSourceReview({
  cwd,
  sourceCommit,
  priorProtectedCommit,
  upstreamMainRef,
  targetTag,
  targetRef = targetTag,
  review,
  ledger,
  enforceKnownIdentities = false,
}) {
  const source = git(cwd, "rev-parse", `${sourceCommit}^{commit}`);
  const priorProtected = priorProtectedCommit
    ? git(cwd, "rev-parse", `${priorProtectedCommit}^{commit}`)
    : undefined;
  const targetCommit = git(cwd, "rev-parse", `${targetRef}^{commit}`);
  if (review?.toTag !== targetTag || review?.toCommit !== targetCommit) {
    throw new Error("Sync review target does not match the publication target");
  }
  const integrationCommit = findIntegrationCommit(
    cwd,
    source,
    priorProtected,
    targetTag,
    targetCommit,
    upstreamMainRef,
  );
  const previousAlas = git(cwd, "rev-parse", `${integrationCommit}^1`);
  const wrapped = source !== integrationCommit;
  if (priorProtected && !wrapped && previousAlas !== priorProtected) {
    throw new Error(
      `Exact integration first parent ${previousAlas} does not match independently verified prior protected commit ${priorProtected}`,
    );
  }
  if (priorProtected && wrapped && !isFirstParentAncestor(cwd, priorProtected, previousAlas)) {
    throw new Error(
      `Protected merge wrapper first parent ${previousAlas} does not descend from independently verified prior protected commit ${priorProtected}`,
    );
  }
  const previousLedger = readPreviousLedger(cwd, previousAlas);
  if (enforceKnownIdentities) {
    validateClaudePatchIdentities(previousLedger);
    validateClaudePatchIdentities(ledger);
  }
  const canonicalPreservedCommits = verifyCompleteCanonicalPreservedCommits({
    cwd,
    sourceCommit: integrationCommit,
    previousAlas,
    upstreamMainRef,
    targetCommit,
    targetTag,
    review,
  });
  verifyPreservedReferences(cwd, source, review);
  verifyLedgerReviewTransition({ ledger, review, previousLedger });
  const root = mkdtempSync(join(tmpdir(), "verify-sync-source-"));
  const worktree = join(root, "worktree");
  const branch = `verify-sync-source-${process.pid}-${basename(root)}`;
  let candidateCommit;
  try {
    git(cwd, "worktree", "add", "--detach", worktree, targetCommit);
    const candidate = buildSyncCandidate({
      cwd: worktree,
      targetRef: targetCommit,
      targetTag,
      alasRef: previousAlas,
      upstreamMainRef,
      branch,
      review,
      ledger: previousLedger,
      allowReviewedPreserved: true,
    });
    const recorded = recordSyncReviewState({
      cwd: worktree,
      targetRef: targetCommit,
      targetTag,
      review,
      ledger,
    });
    candidateCommit = recorded.commit;
    const integrationCandidate = git(cwd, "rev-parse", `${integrationCommit}^2`);
    if (integrationCandidate !== candidateCommit) {
      throw new Error(
        `Integration candidate ${integrationCandidate} does not equal exact reviewed candidate ${candidateCommit}`,
      );
    }
    const expectedParents = [previousAlas, candidateCommit];
    if (canonicalPreservedCommits.length > 0) {
      expectedParents.push(canonicalPreservedCommits.at(-1).commit);
    }
    const actualParents = git(cwd, "rev-list", "--parents", "-n", "1", integrationCommit)
      .split(" ")
      .slice(1);
    if (JSON.stringify(actualParents) !== JSON.stringify(expectedParents)) {
      throw new Error(
        `Integration parents do not exactly match reviewed provenance: expected ${expectedParents.join(", ")}; received ${actualParents.join(", ")}`,
      );
    }
    const expectedIntegration = createProtectedIntegrationCommit({
      cwd,
      tree: git(cwd, "rev-parse", `${candidateCommit}^{tree}`),
      parentCommits: expectedParents,
      targetCommit,
      targetTag,
    });
    if (integrationCommit !== expectedIntegration) {
      throw new Error(
        `Publication integration ${integrationCommit} is not the exact deterministic reviewed integration ${expectedIntegration}`,
      );
    }
    sourceTreeMatchesCandidate(cwd, source, candidate.candidateCommit);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd, encoding: "utf8" });
    spawnSync("git", ["branch", "-D", branch], { cwd, encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
  }
  return {
    sourceCommit: source,
    integrationCommit,
    previousAlas,
    candidateCommit,
    preservedCommits: canonicalPreservedCommits.map((entry) => entry.commit),
  };
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = verifySyncSourceReview({
    cwd: resolve(args.cwd ?? "."),
    sourceCommit: args["source-commit"],
    priorProtectedCommit: args["prior-protected-commit"],
    upstreamMainRef: args["upstream-main-ref"],
    targetRef: args["target-ref"] ?? args["target-tag"],
    targetTag: args["target-tag"],
    review: JSON.parse(readFileSync(resolve(args.review), "utf8")),
    ledger: JSON.parse(readFileSync(resolve(args.ledger), "utf8")),
    enforceKnownIdentities: true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
