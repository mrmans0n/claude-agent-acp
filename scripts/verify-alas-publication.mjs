#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alas\.(0|[1-9]\d*)$/;

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} ${JSON.stringify(actual)} does not equal ${JSON.stringify(expected)}`,
    );
  }
}

function validateExpected({ version, sourceCommit, upstreamVersion, upstreamCommit }) {
  if (!VERSION.test(version ?? "")) throw new Error("Expected downstream version is invalid");
  if (!FULL_COMMIT.test(sourceCommit ?? "")) throw new Error("Expected source commit is invalid");
  if (!/^\d+\.\d+\.\d+$/.test(upstreamVersion ?? "")) {
    throw new Error("Expected upstream version is invalid");
  }
  if (!FULL_COMMIT.test(upstreamCommit ?? "")) {
    throw new Error("Expected upstream commit is invalid");
  }
}

export function verifyNpmPublication({
  npmMetadata,
  packageName,
  version,
  integrity,
  upstreamVersion,
  upstreamCommit,
  sourceCommit,
}) {
  validateExpected({ version, sourceCommit, upstreamVersion, upstreamCommit });
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("Expected npm integrity is invalid");
  }
  requireEqual(npmMetadata?.["dist-tags"]?.latest, version, "npm latest");
  const manifest = npmMetadata?.versions?.[version];
  if (!manifest) throw new Error(`npm version metadata for ${version} is missing`);
  requireEqual(manifest.name, packageName, "npm package name");
  requireEqual(manifest.version, version, "npm package version");
  requireEqual(manifest.dist?.integrity, integrity, "npm dist integrity");
  requireEqual(manifest.alasDownstream?.upstreamVersion, upstreamVersion, "upstream version");
  requireEqual(manifest.alasDownstream?.upstreamCommit, upstreamCommit, "upstream commit");
  requireEqual(manifest.alasDownstream?.sourceCommit, sourceCommit, "source commit");
  const attestations = manifest.dist?.attestations;
  if (
    typeof attestations?.url !== "string" ||
    !attestations.url.startsWith("https://") ||
    typeof attestations?.provenance?.predicateType !== "string" ||
    attestations.provenance.predicateType.length === 0
  ) {
    throw new Error("npm dist.attestations provenance is missing or invalid");
  }
  return { packageName, version, integrity, upstreamVersion, upstreamCommit, sourceCommit };
}

export function verifyGithubPublication({
  tag,
  version,
  sourceCommit,
  upstreamVersion,
  upstreamCommit,
  tagRef,
  release,
}) {
  validateExpected({ version, sourceCommit, upstreamVersion, upstreamCommit });
  requireEqual(tag, `alas-v${version}`, "release tag");
  requireEqual(tagRef?.ref, `refs/tags/${tag}`, "GitHub tag ref");
  requireEqual(tagRef?.object?.type, "commit", "GitHub tag object type");
  requireEqual(tagRef?.object?.sha, sourceCommit, "GitHub tag target");
  requireEqual(release?.tag_name, tag, "GitHub release tag");
  requireEqual(release?.target_commitish, sourceCommit, "GitHub release target");
  requireEqual(release?.draft, false, "GitHub release draft flag");
  requireEqual(release?.prerelease, false, "GitHub release prerelease flag");
  const expectedNotes = `npm: @alas-ide/claude-agent-acp@${version}. Upstream tag: v${upstreamVersion}. Upstream commit: ${upstreamCommit}. Source commit: ${sourceCommit}.`;
  requireEqual(release?.body, expectedNotes, "GitHub release notes");
  return { tag, version, sourceCommit, upstreamVersion, upstreamCommit };
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
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const common = {
    version: args.version,
    sourceCommit: args["source-commit"],
    upstreamVersion: args["upstream-version"],
    upstreamCommit: args["upstream-commit"],
  };
  const result =
    args.mode === "npm"
      ? verifyNpmPublication({
          ...common,
          packageName: args.package,
          integrity: args.integrity,
          npmMetadata: readJson(args.metadata),
        })
      : args.mode === "github"
        ? verifyGithubPublication({
            ...common,
            tag: args.tag,
            tagRef: readJson(args["tag-ref"]),
            release: readJson(args.release),
          })
        : (() => {
            throw new Error(`Unsupported --mode ${args.mode}`);
          })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
