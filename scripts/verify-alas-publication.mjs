#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alas\.(0|[1-9]\d*)$/;
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const SLSA_GITHUB_WORKFLOW_V1 =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";

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

function verifyProvenanceAttestation({
  packageName,
  version,
  sourceCommit,
  integrity,
  expectedRepository,
  expectedWorkflowPath,
  expectedWorkflowRef,
  attestation,
}) {
  const provenance =
    attestation?.attestations?.filter(
      ({ predicateType }) => predicateType === SLSA_PROVENANCE_V1,
    ) ?? [];
  if (provenance.length !== 1) {
    throw new Error(`npm provenance attestation count mismatch for ${packageName}@${version}`);
  }
  const bundle = provenance[0].bundle;
  if (
    bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json" ||
    bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" ||
    typeof bundle.dsseEnvelope.payload !== "string"
  ) {
    throw new Error(`npm provenance bundle format mismatch for ${packageName}@${version}`);
  }
  let statement;
  try {
    statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  } catch {
    throw new Error(`npm provenance payload is invalid for ${packageName}@${version}`);
  }
  const integrityDigest = Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
  const encodedPackageName = packageName.startsWith("@")
    ? `%40${packageName.slice(1)}`
    : packageName;
  const expectedSubject = `pkg:npm/${encodedPackageName}@${version}`;
  if (
    statement?._type !== "https://in-toto.io/Statement/v1" ||
    statement?.predicateType !== SLSA_PROVENANCE_V1 ||
    statement?.subject?.length !== 1 ||
    statement.subject[0]?.name !== expectedSubject ||
    statement.subject[0]?.digest?.sha512 !== integrityDigest
  ) {
    throw new Error(`npm provenance subject integrity mismatch for ${packageName}@${version}`);
  }
  const buildDefinition = statement.predicate?.buildDefinition;
  const workflow = buildDefinition?.externalParameters?.workflow;
  if (
    buildDefinition?.buildType !== SLSA_GITHUB_WORKFLOW_V1 ||
    workflow?.repository !== expectedRepository ||
    workflow?.path !== expectedWorkflowPath ||
    workflow?.ref !== expectedWorkflowRef
  ) {
    throw new Error(`npm provenance workflow identity mismatch for ${packageName}@${version}`);
  }
  const dependencies = buildDefinition?.resolvedDependencies;
  if (
    !Array.isArray(dependencies) ||
    dependencies.length !== 1 ||
    dependencies[0]?.uri !== `git+${expectedRepository}@${expectedWorkflowRef}` ||
    dependencies[0]?.digest?.gitCommit !== sourceCommit
  ) {
    throw new Error(`npm provenance source commit mismatch for ${packageName}@${version}`);
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
  attestation,
  expectedRepository,
  expectedWorkflowPath,
  expectedWorkflowRef,
  requireLatest = true,
}) {
  validateExpected({ version, sourceCommit, upstreamVersion, upstreamCommit });
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("Expected npm integrity is invalid");
  }
  if (requireLatest) {
    requireEqual(npmMetadata?.["dist-tags"]?.latest, version, "npm latest");
  }
  const manifest = npmMetadata?.versions?.[version];
  if (!manifest) throw new Error(`npm version metadata for ${version} is missing`);
  requireEqual(manifest.name, packageName, "npm package name");
  requireEqual(manifest.version, version, "npm package version");
  requireEqual(manifest.dist?.integrity, integrity, "npm dist integrity");
  requireEqual(manifest.alasDownstream?.upstreamVersion, upstreamVersion, "upstream version");
  requireEqual(manifest.alasDownstream?.upstreamCommit, upstreamCommit, "upstream commit");
  requireEqual(manifest.alasDownstream?.sourceCommit, sourceCommit, "source commit");
  const attestations = manifest.dist?.attestations;
  let attestationUrl;
  try {
    attestationUrl = new URL(attestations?.url);
  } catch {
    throw new Error("npm dist.attestations provenance is missing or invalid");
  }
  const attestationPrefix = "/-/npm/v1/attestations/";
  const attestationSubject = attestationUrl.pathname.startsWith(attestationPrefix)
    ? decodeURIComponent(attestationUrl.pathname.slice(attestationPrefix.length))
    : "";
  if (
    attestationUrl.origin !== "https://registry.npmjs.org" ||
    attestationSubject !== `${packageName}@${version}` ||
    attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1
  ) {
    throw new Error("npm dist.attestations provenance is missing or invalid");
  }
  verifyProvenanceAttestation({
    packageName,
    version,
    sourceCommit,
    integrity,
    expectedRepository,
    expectedWorkflowPath,
    expectedWorkflowRef,
    attestation,
  });
  return { packageName, version, integrity, upstreamVersion, upstreamCommit, sourceCommit };
}

export function verifyInstalledPublication({
  packageName,
  version,
  integrity,
  attestationUrl,
  attestation,
  lock,
  audit,
}) {
  requireEqual(lock?.packages?.[""]?.dependencies?.[packageName], version, "installed request");
  const packageSuffix = `node_modules/${packageName}`;
  const installed = Object.entries(lock?.packages ?? {})
    .filter(([path]) => path === packageSuffix || path.endsWith(`/${packageSuffix}`))
    .map(([, manifest]) => manifest);
  if (
    installed.length !== 1 ||
    installed[0]?.version !== version ||
    installed[0]?.integrity !== integrity
  ) {
    throw new Error(`Installed package version/integrity does not match ${packageName}@${version}`);
  }
  if (
    !Array.isArray(audit?.invalid) ||
    !Array.isArray(audit?.missing) ||
    audit.invalid.length > 0 ||
    audit.missing.length > 0
  ) {
    throw new Error(`npm signature/provenance verification failed: ${JSON.stringify(audit)}`);
  }
  const verified = Array.isArray(audit?.verified)
    ? audit.verified.filter((entry) => entry?.name === packageName && entry?.version === version)
    : [];
  if (
    verified.length !== 1 ||
    verified[0]?.attestations?.url !== attestationUrl ||
    verified[0]?.attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1 ||
    !isDeepStrictEqual(verified[0]?.attestationBundles, attestation?.attestations)
  ) {
    throw new Error(`npm verified attestation does not exactly match ${packageName}@${version}`);
  }
  return { version, integrity };
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
  let result;
  if (args.mode === "npm") {
    const requireLatest = args["require-latest"] ?? "true";
    if (!/^(true|false)$/.test(requireLatest)) {
      throw new Error("--require-latest must be true or false");
    }
    result = verifyNpmPublication({
      ...common,
      packageName: args.package,
      integrity: args.integrity,
      npmMetadata: readJson(args.metadata),
      attestation: readJson(args.attestation),
      expectedRepository: args["expected-repository"],
      expectedWorkflowPath: args["expected-workflow-path"],
      expectedWorkflowRef: args["expected-workflow-ref"],
      requireLatest: requireLatest === "true",
    });
  } else if (args.mode === "installed") {
    result = verifyInstalledPublication({
      packageName: args.package,
      version: args.version,
      integrity: args.integrity,
      attestationUrl: args["attestation-url"],
      attestation: readJson(args.attestation),
      lock: readJson(args.lock),
      audit: readJson(args.audit),
    });
  } else if (args.mode === "github") {
    result = verifyGithubPublication({
      ...common,
      tag: args.tag,
      tagRef: readJson(args["tag-ref"]),
      release: readJson(args.release),
    });
  } else {
    throw new Error(`Unsupported --mode ${args.mode}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
