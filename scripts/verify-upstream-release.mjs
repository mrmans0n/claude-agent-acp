import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;

function parts(value, pattern) {
  const match = pattern.exec(value ?? "");
  return match?.slice(1).map(BigInt) ?? null;
}

export function compareVersions(left, right) {
  const leftParts = parts(left, VERSION);
  const rightParts = parts(right, VERSION);
  if (!leftParts || !rightParts)
    throw new Error(`Invalid stable version comparison: ${left}, ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index])
      return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

export function verifyUpstreamRelease({
  selectedTag,
  selectedCommit,
  packageVersion,
  githubRelease,
  npmMetadata,
  requireNewer = true,
}) {
  const tagParts = parts(selectedTag, STABLE_TAG);
  if (!tagParts) throw new Error(`Selected tag ${selectedTag} is not stable vX.Y.Z`);
  if (!COMMIT.test(selectedCommit ?? ""))
    throw new Error("Selected tag commit must be a full hash");
  if (!VERSION.test(packageVersion ?? ""))
    throw new Error("package.json version must be stable X.Y.Z");
  const version = selectedTag.slice(1);
  const comparison = compareVersions(version, packageVersion);
  if ((requireNewer && comparison <= 0) || (!requireNewer && comparison !== 0)) {
    throw new Error(
      `Selected version ${version} must be newer than package version ${packageVersion}`,
    );
  }
  if (!githubRelease || githubRelease.tag_name !== selectedTag) {
    throw new Error(`GitHub release tag does not match selected tag ${selectedTag}`);
  }
  if (githubRelease.draft) throw new Error(`GitHub release ${selectedTag} is a draft`);
  if (githubRelease.prerelease) throw new Error(`GitHub release ${selectedTag} is a prerelease`);
  const latest = npmMetadata?.["dist-tags"]?.latest;
  if (latest !== version) {
    throw new Error(`npm latest ${latest ?? "missing"} does not match selected version ${version}`);
  }
  const versionMetadata = npmMetadata?.versions?.[version];
  if (!versionMetadata || typeof versionMetadata !== "object") {
    throw new Error(`npm version metadata is missing for ${version}`);
  }
  const gitHead = versionMetadata.gitHead;
  if (gitHead !== undefined && gitHead !== selectedCommit) {
    throw new Error(`npm gitHead ${gitHead} does not match selected tag commit ${selectedCommit}`);
  }
  return { tag: selectedTag, version, commit: selectedCommit };
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
  const result = verifyUpstreamRelease({
    selectedTag: args.tag,
    selectedCommit: args.commit,
    packageVersion,
    githubRelease: JSON.parse(readFileSync(resolve(args["github-release"]), "utf8")),
    npmMetadata: JSON.parse(readFileSync(resolve(args["npm-metadata"]), "utf8")),
    requireNewer: args["allow-current"] !== "true",
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) writeFileSync(resolve(args.output), output);
  process.stdout.write(output);
}
