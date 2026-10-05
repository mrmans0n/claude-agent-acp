import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function revList(cwd, ...args) {
  const output = git(cwd, "rev-list", "--reverse", "--topo-order", ...args);
  return output ? output.split("\n") : [];
}

function isMerge(cwd, commit) {
  return git(cwd, "rev-list", "--parents", "-n", "1", commit).split(" ").length > 2;
}

function patchIsPresent(cwd, commit, head = "HEAD") {
  const parent = git(cwd, "rev-parse", `${commit}^`);
  return git(cwd, "cherry", head, commit, parent).startsWith("-");
}

function patchId(cwd, commit) {
  const patch = isMerge(cwd, commit)
    ? execFileSync("git", ["diff", "--binary", `${commit}^1`, commit], { cwd })
    : execFileSync("git", ["show", "--pretty=format:", "--binary", commit], { cwd });
  const result = spawnSync("git", ["patch-id", "--stable"], {
    cwd,
    input: patch,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Cannot compute patch-id for ${commit}`);
  }
  return result.stdout.trim().split(/\s+/)[0];
}

function cherryPickDeterministically(cwd, commit) {
  const args = ["cherry-pick"];
  if (isMerge(cwd, commit)) args.push("-m", "1");
  args.push(commit);
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_COMMITTER_DATE: git(cwd, "show", "-s", "--format=%cI", commit),
    },
  });
  if (result.status !== 0) {
    spawnSync("git", ["cherry-pick", "--abort"], { cwd, encoding: "utf8" });
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Failed to reapply ${commit}${detail ? `:\n${detail}` : ""}`);
  }
}

function commitSummary(cwd, commit) {
  return {
    commit,
    subject: git(cwd, "show", "-s", "--format=%s", commit),
    ...(isMerge(cwd, commit)
      ? { constituentCommits: revList(cwd, `${commit}^2`, "--not", `${commit}^1`) }
      : {}),
  };
}

function isReviewOnlyCommit(cwd, commit) {
  const parent = git(cwd, "rev-parse", `${commit}^1`);
  const paths = git(cwd, "diff", "--name-only", parent, commit).split("\n").filter(Boolean);
  const reviewPaths = new Set(["docs/ALAS_SYNC_REVIEW.json", "docs/ALAS_DOWNSTREAM_PATCHES.json"]);
  return paths.length > 0 && paths.every((path) => reviewPaths.has(path));
}

function isGeneratedIntegrationCommit(cwd, commit, targetCommit, upstreamMainRef, targetTag) {
  if (!isMerge(cwd, commit)) return false;
  if (git(cwd, "show", "-s", "--format=%s", commit) !== `chore: integrate upstream ${targetTag}`) {
    return false;
  }
  const parents = git(cwd, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
  if (parents.length < 2) return false;
  const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
  if (git(cwd, "show", "-s", "--format=%ae%n%ce", commit) !== `${botEmail}\n${botEmail}`) {
    return false;
  }
  return (
    git(cwd, "rev-parse", `${commit}^{tree}`) === git(cwd, "rev-parse", `${parents[1]}^{tree}`) &&
    git(cwd, "merge-base", commit, upstreamMainRef) === targetCommit
  );
}

function discoverCanonicalCandidates({
  cwd,
  canonicalSyncRef,
  alasRef,
  upstreamMainRef,
  targetCommit,
  targetTag,
  seen = new Set(),
}) {
  const candidates = [];
  for (const commit of revList(
    cwd,
    "--first-parent",
    canonicalSyncRef,
    "--not",
    alasRef,
    upstreamMainRef,
  )) {
    if (seen.has(commit)) continue;
    seen.add(commit);
    if (isGeneratedIntegrationCommit(cwd, commit, targetCommit, upstreamMainRef, targetTag)) {
      const parents = git(cwd, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
      if (parents.length >= 3) {
        candidates.push(
          ...discoverCanonicalCandidates({
            cwd,
            canonicalSyncRef: parents[2],
            alasRef,
            upstreamMainRef,
            targetCommit,
            targetTag,
            seen,
          }),
        );
      }
      continue;
    }
    candidates.push(commit);
  }
  return candidates;
}

export function discoverCanonicalPreservedCommits(options) {
  return discoverCanonicalCandidates(options)
    .filter((commit) => !isReviewOnlyCommit(options.cwd, commit))
    .map((commit) => commitSummary(options.cwd, commit));
}

export function buildSyncCandidate({
  cwd,
  targetRef,
  alasRef,
  upstreamMainRef,
  branch,
  canonicalSyncRef,
  expectedCanonicalCommit,
  targetTag = targetRef,
  review,
  ledger,
  allowReviewedPreserved = false,
}) {
  const baseCommit = git(cwd, "rev-parse", `${targetRef}^{commit}`);
  git(cwd, "rev-parse", `${alasRef}^{commit}`);
  git(cwd, "rev-parse", `${upstreamMainRef}^{commit}`);

  let preservedCandidates = [];
  if (canonicalSyncRef) {
    const actual = git(cwd, "rev-parse", `${canonicalSyncRef}^{commit}`);
    if (actual !== expectedCanonicalCommit) {
      throw new Error(
        `Canonical sync ref ${canonicalSyncRef} moved from ${expectedCanonicalCommit} to ${actual}; refusing to overwrite it`,
      );
    }
    preservedCandidates = discoverCanonicalCandidates({
      cwd,
      canonicalSyncRef,
      alasRef,
      upstreamMainRef,
      targetCommit: baseCommit,
      targetTag,
    });
  }

  const reviewMatchesTarget =
    review?.toTag === targetTag && (!review.toCommit || review.toCommit === baseCommit);
  const patchResolutions = new Map(
    reviewMatchesTarget
      ? review.patches.map((patch) => [patch.commit, patch.resolution ?? null])
      : [],
  );
  const preservedResolutions = new Map(
    reviewMatchesTarget
      ? (review.preservedCommits ?? []).map((entry) => [entry.commit, entry.resolution ?? null])
      : [],
  );
  for (const commit of preservedResolutions.keys()) {
    if (preservedCandidates.includes(commit)) continue;
    if (!allowReviewedPreserved) {
      throw new Error(`Reviewed preserved commit ${commit} is not on the canonical sync branch`);
    }
    preservedCandidates.push(commit);
  }
  const droppedCommits = new Set(
    [...patchResolutions]
      .filter(([, resolution]) => ["drop", "adapt"].includes(resolution?.decision))
      .map(([commit]) => commit),
  );
  for (const commit of ledger?.retiredCommits ?? []) droppedCommits.add(commit);
  const persistentPreservedCandidates = [];
  for (const transition of ledger?.preservedTransitions ?? []) {
    for (const commit of [transition.commit, ...(transition.constituentCommits ?? [])]) {
      droppedCommits.add(commit);
    }
    if (transition.decision === "retain") persistentPreservedCandidates.push(transition.commit);
    if (transition.decision === "adapt") {
      persistentPreservedCandidates.push(transition.replacementCommit);
    }
  }
  for (const patch of ledger?.patches ?? []) {
    for (const commit of patch.retiredCommits ?? []) droppedCommits.add(commit);
    if (patch.disposition === "dropped") droppedCommits.add(patch.commit);
  }
  const droppedPatchIds = new Set([...droppedCommits].map((commit) => patchId(cwd, commit)));
  const adaptationCandidates = [...patchResolutions.values()]
    .filter((resolution) => resolution?.decision === "adapt")
    .map((resolution) => resolution.commit);
  const downstreamCommits = revList(cwd, "--no-merges", alasRef, "--not", upstreamMainRef);
  git(cwd, "checkout", "-B", branch, baseCommit);

  const reappliedDownstream = [];
  const skippedCommits = [];
  const reviewCommits = [];
  for (const commit of downstreamCommits) {
    if (isReviewOnlyCommit(cwd, commit)) {
      reviewCommits.push(commitSummary(cwd, commit));
      continue;
    }
    if (droppedCommits.has(commit) || droppedPatchIds.has(patchId(cwd, commit))) {
      skippedCommits.push(commit);
      continue;
    }
    if (patchIsPresent(cwd, commit)) continue;
    cherryPickDeterministically(cwd, commit);
    reappliedDownstream.push(commitSummary(cwd, commit));
  }

  const adaptationCommits = [];
  for (const commit of adaptationCandidates) {
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
      throw new Error("Adapt resolutions must identify a full replacement commit");
    }
    if (patchIsPresent(cwd, commit)) continue;
    cherryPickDeterministically(cwd, commit);
    adaptationCommits.push(commitSummary(cwd, commit));
  }

  const persistentPreservedCommits = [];
  const persistentApplied = new Set();
  for (const commit of [...new Set(persistentPreservedCandidates)]) {
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
      throw new Error("Persistent preserved resolutions must identify a full commit");
    }
    if (!isMerge(cwd, commit) && patchIsPresent(cwd, commit)) continue;
    cherryPickDeterministically(cwd, commit);
    persistentApplied.add(commit);
    persistentPreservedCommits.push(commitSummary(cwd, commit));
  }

  const durableRetiredPatchIds = new Set(
    (ledger?.retiredCommits ?? []).map((commit) => patchId(cwd, commit)),
  );
  const preservedCommits = [];
  for (const originalCommit of preservedCandidates) {
    const resolution = preservedResolutions.get(originalCommit);
    const tracked = preservedResolutions.has(originalCommit);
    if (isReviewOnlyCommit(cwd, originalCommit)) {
      reviewCommits.push(commitSummary(cwd, originalCommit));
      continue;
    }
    if (
      (ledger?.retiredCommits ?? []).includes(originalCommit) ||
      durableRetiredPatchIds.has(patchId(cwd, originalCommit))
    ) {
      skippedCommits.push(originalCommit);
      continue;
    }
    if (!tracked && !isMerge(cwd, originalCommit) && patchIsPresent(cwd, originalCommit)) continue;
    const summary = commitSummary(cwd, originalCommit);
    preservedCommits.push(summary);
    if (resolution?.decision === "drop") continue;
    const commit = resolution?.decision === "adapt" ? resolution.commit : originalCommit;
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
      throw new Error("Adapt resolutions must identify a full replacement commit");
    }
    if (persistentApplied.has(commit)) continue;
    if (!isMerge(cwd, commit) && patchIsPresent(cwd, commit)) continue;
    cherryPickDeterministically(cwd, commit);
  }

  const mergeBase = git(cwd, "merge-base", "HEAD", upstreamMainRef);
  if (mergeBase !== baseCommit) {
    throw new Error(
      `Candidate merge-base ${mergeBase} does not equal exact stable tag commit ${baseCommit}`,
    );
  }
  return {
    branch,
    baseCommit,
    candidateCommit: git(cwd, "rev-parse", "HEAD"),
    downstreamCommits: reappliedDownstream,
    skippedCommits,
    adaptationCommits,
    persistentPreservedCommits,
    preservedCommits,
    reviewCommits,
    manualReview: preservedCommits.length > 0,
  };
}

export function buildProtectedIntegration({
  cwd,
  targetRef,
  candidateRef,
  alasRef,
  upstreamMainRef,
  branch,
  targetTag = targetRef,
  canonicalSyncRef,
  expectedCanonicalCommit,
}) {
  const targetCommit = git(cwd, "rev-parse", `${targetRef}^{commit}`);
  const candidateCommit = git(cwd, "rev-parse", `${candidateRef}^{commit}`);
  const alasCommit = git(cwd, "rev-parse", `${alasRef}^{commit}`);
  const previousUpstreamBase = git(cwd, "merge-base", alasCommit, upstreamMainRef);
  const targetOnMain = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", targetCommit, upstreamMainRef],
    { cwd },
  );
  if (targetOnMain.status !== 0)
    throw new Error("Target stable tag is not contained by upstream main");
  const oldBaseContained = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", previousUpstreamBase, targetCommit],
    { cwd },
  );
  if (oldBaseContained.status !== 0) {
    throw new Error(
      `Old upstream contamination ${previousUpstreamBase} is not contained by target ${targetCommit}`,
    );
  }
  const candidateMergeBase = git(cwd, "merge-base", candidateCommit, upstreamMainRef);
  if (candidateMergeBase !== targetCommit) {
    throw new Error(
      `Exact candidate merge-base ${candidateMergeBase} does not equal target ${targetCommit}`,
    );
  }

  const tree = git(cwd, "rev-parse", `${candidateCommit}^{tree}`);
  let canonicalCommit;
  if (canonicalSyncRef) {
    canonicalCommit = git(cwd, "rev-parse", `${canonicalSyncRef}^{commit}`);
    if (canonicalCommit !== expectedCanonicalCommit) {
      throw new Error(
        `Canonical sync ref ${canonicalSyncRef} moved from ${expectedCanonicalCommit} to ${canonicalCommit}; refusing to overwrite it`,
      );
    }
    const canonicalTree = git(cwd, "rev-parse", `${canonicalCommit}^{tree}`);
    const alasIsAncestor = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", alasCommit, canonicalCommit],
      { cwd },
    );
    const canonicalMergeBase = git(cwd, "merge-base", canonicalCommit, upstreamMainRef);
    if (
      canonicalTree === tree &&
      alasIsAncestor.status === 0 &&
      canonicalMergeBase === targetCommit
    ) {
      git(cwd, "update-ref", `refs/heads/${branch}`, canonicalCommit);
      git(cwd, "checkout", branch);
      return {
        branch,
        targetCommit,
        candidateCommit,
        alasCommit,
        previousUpstreamBase,
        integrationCommit: canonicalCommit,
        mergeBase: canonicalMergeBase,
        reused: true,
      };
    }
  }
  const date = git(cwd, "show", "-s", "--format=%cI", targetCommit);
  const message = `chore: integrate upstream ${targetTag}`;
  const parents = ["-p", alasCommit, "-p", candidateCommit];
  if (canonicalCommit && canonicalCommit !== alasCommit && canonicalCommit !== candidateCommit) {
    parents.push("-p", canonicalCommit);
  }
  const integrationCommit = execFileSync("git", ["commit-tree", tree, ...parents, "-m", message], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_DATE: date,
    },
  }).trim();
  git(cwd, "update-ref", `refs/heads/${branch}`, integrationCommit);
  git(cwd, "checkout", branch);

  const integrationMergeBase = git(cwd, "merge-base", integrationCommit, upstreamMainRef);
  if (integrationMergeBase !== targetCommit) {
    throw new Error(
      `Integration merge-base ${integrationMergeBase} does not equal target ${targetCommit}`,
    );
  }
  return {
    branch,
    targetCommit,
    candidateCommit,
    alasCommit,
    previousUpstreamBase,
    integrationCommit,
    mergeBase: integrationMergeBase,
    reused: false,
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
  const cwd = resolve(args.cwd ?? ".");
  const common = {
    cwd,
    targetRef: args["target-ref"],
    alasRef: args["alas-ref"],
    upstreamMainRef: args["upstream-main-ref"],
    branch: args.branch,
  };
  const result =
    args.mode === "integration"
      ? buildProtectedIntegration({
          ...common,
          candidateRef: args["candidate-ref"],
          targetTag: args["target-tag"] ?? args["target-ref"],
          canonicalSyncRef: args["canonical-sync-ref"],
          expectedCanonicalCommit: args["expected-canonical-commit"],
        })
      : buildSyncCandidate({
          ...common,
          canonicalSyncRef: args["canonical-sync-ref"],
          expectedCanonicalCommit: args["expected-canonical-commit"],
          targetTag: args["target-tag"] ?? args["target-ref"],
          review: args.review ? JSON.parse(readFileSync(resolve(args.review), "utf8")) : undefined,
          ledger: args.ledger ? JSON.parse(readFileSync(resolve(args.ledger), "utf8")) : undefined,
        });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) writeFileSync(resolve(args.output), output);
  process.stdout.write(output);
}
