import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function isAncestor(cwd, ancestor, descendant) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "pipe" })
      .status === 0
  );
}

/**
 * Verifies a downstream-only hotfix publication.
 *
 * A hotfix republishes the upstream version of the verified prior publication with reviewed fork
 * commits on top. It must descend from that publication and must not bring in upstream history
 * beyond what the publication already contained.
 */
export function verifyAlasHotfix({
  cwd,
  sourceCommit,
  priorSourceCommit,
  priorUpstreamVersion,
  priorUpstreamCommit,
  upstreamMainRef,
  stableTagRef,
  declaredTag,
  packageVersion,
}) {
  if (!COMMIT.test(sourceCommit ?? ""))
    throw new Error("Source commit must be a 40-character hash");
  if (!COMMIT.test(priorSourceCommit ?? ""))
    throw new Error("Prior source commit must be a 40-character hash");
  if (!STABLE_TAG.test(declaredTag ?? ""))
    throw new Error("Declared upstream tag must be stable vX.Y.Z");
  if (declaredTag !== `v${packageVersion}`) {
    throw new Error(`Declared tag ${declaredTag} does not match package version ${packageVersion}`);
  }
  const stableCommit = git(cwd, "rev-parse", `${stableTagRef}^{commit}`);
  if (declaredTag !== `v${priorUpstreamVersion}` || stableCommit !== priorUpstreamCommit) {
    throw new Error(
      `Prior publication is based on v${priorUpstreamVersion} (${priorUpstreamCommit}), not ${declaredTag} (${stableCommit})`,
    );
  }
  if (!isAncestor(cwd, priorSourceCommit, sourceCommit)) {
    throw new Error(
      `Source ${sourceCommit} does not descend from prior publication source ${priorSourceCommit}`,
    );
  }
  const priorMergeBase = git(cwd, "merge-base", priorSourceCommit, upstreamMainRef);
  const mergeBase = git(cwd, "merge-base", sourceCommit, upstreamMainRef);
  if (mergeBase !== priorMergeBase) {
    throw new Error(
      `Hotfix brings in upstream history: merge-base moved from ${priorMergeBase} to ${mergeBase}`,
    );
  }
  return { sourceCommit, declaredTag, stableCommit, priorSourceCommit, mergeBase };
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
  const packageVersion = JSON.parse(
    readFileSync(resolve(cwd, args.package ?? "package.json"), "utf8"),
  ).version;
  const result = verifyAlasHotfix({
    cwd,
    sourceCommit: args["source-commit"],
    priorSourceCommit: args["prior-source-commit"],
    priorUpstreamVersion: args["prior-upstream-version"],
    priorUpstreamCommit: args["prior-upstream-commit"],
    upstreamMainRef: args["upstream-main-ref"],
    stableTagRef: args["stable-tag-ref"],
    declaredTag: args["declared-tag"],
    packageVersion,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) writeFileSync(resolve(args.output), output);
  process.stdout.write(output);
}
