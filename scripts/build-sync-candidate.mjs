import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function revList(cwd, ...args) {
  return git(cwd, "rev-list", "--reverse", "--topo-order", ...args)
    .split("\n")
    .filter(Boolean);
}

function patchIsPresent(cwd, commit, head = "HEAD") {
  const parent = git(cwd, "rev-parse", `${commit}^`);
  return git(cwd, "cherry", head, commit, parent).startsWith("-");
}

function cherryPick(cwd, commit) {
  const result = spawnSync("git", ["cherry-pick", commit], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    spawnSync("git", ["cherry-pick", "--abort"], { cwd, encoding: "utf8" });
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Failed to reapply ${commit}${detail ? `:\n${detail}` : ""}`);
  }
}

export function buildSyncCandidate({
  cwd,
  targetRef,
  alasRef,
  upstreamMainRef,
  branch,
  syncRefs = [],
}) {
  const baseCommit = git(cwd, "rev-parse", `${targetRef}^{commit}`);
  git(cwd, "rev-parse", `${alasRef}^{commit}`);
  git(cwd, "rev-parse", `${upstreamMainRef}^{commit}`);

  for (const { ref, expectedCommit } of syncRefs) {
    const actual = git(cwd, "rev-parse", `${ref}^{commit}`);
    if (actual !== expectedCommit) {
      throw new Error(
        `Sync ref ${ref} moved from ${expectedCommit} to ${actual}; refusing to overwrite it`,
      );
    }
  }

  const downstreamCommits = revList(cwd, alasRef, "--not", upstreamMainRef);
  const preservedCandidates = [];
  const seen = new Set(downstreamCommits);
  for (const { ref } of syncRefs) {
    for (const commit of revList(cwd, ref, "--not", alasRef, upstreamMainRef)) {
      if (!seen.has(commit)) {
        seen.add(commit);
        preservedCandidates.push(commit);
      }
    }
  }

  git(cwd, "checkout", "-B", branch, baseCommit);
  const reappliedDownstream = [];
  for (const commit of downstreamCommits) {
    if (patchIsPresent(cwd, commit)) continue;
    cherryPick(cwd, commit);
    reappliedDownstream.push(commit);
  }
  const preservedCommits = [];
  for (const commit of preservedCandidates) {
    if (patchIsPresent(cwd, commit)) continue;
    cherryPick(cwd, commit);
    preservedCommits.push(commit);
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
    preservedCommits,
  };
}

function parseArgs(argv) {
  const values = { "sync-ref": [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key}`);
    const name = key.slice(2);
    if (name === "sync-ref") values[name].push(value);
    else values[name] = value;
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const syncRefs = args["sync-ref"].map((value) => {
    const separator = value.lastIndexOf("=");
    if (separator < 1) throw new Error(`Expected --sync-ref REF=COMMIT, got ${value}`);
    return { ref: value.slice(0, separator), expectedCommit: value.slice(separator + 1) };
  });
  const result = buildSyncCandidate({
    cwd: resolve(args.cwd ?? "."),
    targetRef: args["target-ref"],
    alasRef: args["alas-ref"],
    upstreamMainRef: args["upstream-main-ref"],
    branch: args.branch,
    syncRefs,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) writeFileSync(resolve(args.output), output);
  process.stdout.write(output);
}
