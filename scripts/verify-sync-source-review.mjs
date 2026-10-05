import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSyncCandidate, discoverCanonicalPreservedCommits } from "./build-sync-candidate.mjs";
import { verifyLedgerReviewTransition } from "./sync-review.mjs";

const LEDGER_PATH = "docs/ALAS_DOWNSTREAM_PATCHES.json";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function findIntegrationCommit(cwd, sourceCommit, targetTag, targetCommit, upstreamMainRef) {
  const expected = `chore: integrate upstream ${targetTag}`;
  const commits = git(cwd, "rev-list", "--first-parent", sourceCommit).split("\n").filter(Boolean);
  for (const commit of commits) {
    const subject = git(cwd, "show", "-s", "--format=%s", commit);
    const parents = git(cwd, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
    const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
    if (
      subject === expected &&
      parents.length >= 2 &&
      git(cwd, "show", "-s", "--format=%ae%n%ce", commit) === `${botEmail}\n${botEmail}` &&
      git(cwd, "rev-parse", `${commit}^{tree}`) === git(cwd, "rev-parse", `${parents[1]}^{tree}`) &&
      git(cwd, "merge-base", commit, upstreamMainRef) === targetCommit
    ) {
      return commit;
    }
  }
  throw new Error(`Cannot find the ${targetTag} integration commit in source history`);
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
  upstreamMainRef,
  targetTag,
  targetRef = targetTag,
  review,
  ledger,
}) {
  const source = git(cwd, "rev-parse", `${sourceCommit}^{commit}`);
  const targetCommit = git(cwd, "rev-parse", `${targetRef}^{commit}`);
  if (review?.toTag !== targetTag || review?.toCommit !== targetCommit) {
    throw new Error("Sync review target does not match the publication target");
  }
  const integrationCommit = findIntegrationCommit(
    cwd,
    source,
    targetTag,
    targetCommit,
    upstreamMainRef,
  );
  const previousAlas = git(cwd, "rev-parse", `${integrationCommit}^1`);
  const previousLedger = readPreviousLedger(cwd, previousAlas);
  const canonicalPreservedCommits = verifyCompleteCanonicalPreservedCommits({
    cwd,
    sourceCommit: source,
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
      ledger,
      allowReviewedPreserved: true,
    });
    candidateCommit = candidate.candidateCommit;
    sourceTreeMatchesCandidate(cwd, source, candidateCommit);
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
    upstreamMainRef: args["upstream-main-ref"],
    targetRef: args["target-ref"] ?? args["target-tag"],
    targetTag: args["target-tag"],
    review: JSON.parse(readFileSync(resolve(args.review), "utf8")),
    ledger: JSON.parse(readFileSync(resolve(args.ledger), "utf8")),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
