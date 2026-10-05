import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

export function verifyAlasSource({
  cwd,
  sourceCommit,
  upstreamMainRef,
  stableTagRef,
  declaredTag,
  packageVersion,
}) {
  if (!COMMIT.test(sourceCommit ?? ""))
    throw new Error("Source commit must be a 40-character hash");
  if (!STABLE_TAG.test(declaredTag ?? ""))
    throw new Error("Declared upstream tag must be stable vX.Y.Z");
  if (packageVersion !== undefined && declaredTag !== `v${packageVersion}`) {
    throw new Error(`Declared tag ${declaredTag} does not match package version ${packageVersion}`);
  }
  const resolvedSource = git(cwd, "rev-parse", `${sourceCommit}^{commit}`);
  if (resolvedSource !== sourceCommit) throw new Error("Source commit did not resolve exactly");
  const stableCommit = git(cwd, "rev-parse", `${stableTagRef}^{commit}`);
  const mergeBase = git(cwd, "merge-base", sourceCommit, upstreamMainRef);
  if (mergeBase !== stableCommit) {
    throw new Error(
      `Source merge-base ${mergeBase} does not equal declared stable tag commit ${stableCommit}`,
    );
  }
  return { sourceCommit, declaredTag, stableCommit, mergeBase };
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
  const result = verifyAlasSource({
    cwd,
    sourceCommit: args["source-commit"],
    upstreamMainRef: args["upstream-main-ref"],
    stableTagRef: args["stable-tag-ref"],
    declaredTag: args["declared-tag"],
    packageVersion,
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) writeFileSync(resolve(args.output), output);
  process.stdout.write(output);
}
