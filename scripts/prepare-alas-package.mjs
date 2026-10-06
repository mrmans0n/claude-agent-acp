#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UPSTREAM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/i;

function stableVersion(version) {
  const value = String(version ?? "");
  if (!UPSTREAM_VERSION.test(value)) {
    throw new Error(`expected a stable upstream X.Y.Z version, got ${JSON.stringify(version)}`);
  }
  return value;
}

function publishedManifests(published) {
  if (Array.isArray(published)) return published;
  if (published && typeof published === "object") {
    if (published.versions && typeof published.versions === "object") {
      return Object.entries(published.versions).map(([version, manifest]) =>
        typeof manifest === "object" && manifest !== null ? { version, ...manifest } : { version },
      );
    }
    return Object.entries(published).map(([version, manifest]) =>
      typeof manifest === "object" && manifest !== null ? { version, ...manifest } : { version },
    );
  }
  throw new Error("published data must be an array or npm packument object");
}

function publicationSummary(published, version) {
  const manifest = published?.versions?.[version];
  if (
    !version ||
    !manifest?.alasDownstream?.sourceCommit ||
    !manifest?.alasDownstream?.upstreamCommit ||
    !manifest?.alasDownstream?.upstreamVersion ||
    !manifest?.dist?.integrity ||
    !manifest?.dist?.attestations?.url
  ) {
    return undefined;
  }
  return {
    version,
    integrity: manifest.dist.integrity,
    ...manifest.alasDownstream,
  };
}

export function selectPublicationAnchor({ published, sourceCommit, excludedVersions = [] }) {
  if (!FULL_COMMIT.test(String(sourceCommit ?? ""))) {
    throw new Error("sourceCommit must be a full 40-character git commit");
  }
  if (
    !Array.isArray(excludedVersions) ||
    excludedVersions.some((version) => typeof version !== "string")
  ) {
    throw new Error("excludedVersions must be an array of versions");
  }
  const latestVersion = published?.["dist-tags"]?.latest;
  const excluded = new Set(excludedVersions);
  if (excluded.size > 1 || [...excluded].some((version) => version !== latestVersion)) {
    throw new Error("only the verified incomplete latest publication may be excluded");
  }
  const latest = excluded.has(latestVersion)
    ? undefined
    : publicationSummary(published, latestVersion);
  if (!excluded.has(latestVersion) && !latest) {
    throw new Error("latest downstream publication cannot anchor protected history");
  }
  if (latest && latest.sourceCommit !== sourceCommit) return latest;

  const previous = Object.keys(published.versions)
    .filter((version) => version !== latestVersion && !excluded.has(version))
    .map((version) => ({
      publishedAt: Date.parse(published?.time?.[version] ?? ""),
      summary: publicationSummary(published, version),
    }))
    .filter(
      ({ publishedAt, summary }) =>
        Number.isFinite(publishedAt) && summary && summary.sourceCommit !== sourceCommit,
    )
    .sort((left, right) => right.publishedAt - left.publishedAt)[0]?.summary;
  if (!previous) {
    throw new Error("published source has no earlier protected publication anchor");
  }
  return previous;
}

export function selectAlasVersion({ upstreamVersion, upstreamCommit, sourceCommit, published }) {
  const base = stableVersion(upstreamVersion);
  if (!FULL_COMMIT.test(String(sourceCommit ?? ""))) {
    throw new Error("sourceCommit must be a full 40-character git commit");
  }

  const manifests = publishedManifests(published);
  const existing = manifests.find(
    (manifest) => manifest?.alasDownstream?.sourceCommit === sourceCommit,
  );
  if (existing) {
    const expectedVersion = new RegExp(`^${base.replaceAll(".", "\\.")}-alas\\.(0|[1-9]\\d*)$`);
    if (
      !expectedVersion.test(existing.version ?? "") ||
      existing.alasDownstream?.upstreamVersion !== base ||
      existing.alasDownstream?.upstreamCommit !== upstreamCommit
    ) {
      throw new Error(
        `Historical publication ${existing.version} has source metadata for another upstream release`,
      );
    }
    return { version: existing.version, alreadyPublished: true };
  }

  const versionPattern = new RegExp(`^${base.replaceAll(".", "\\.")}-alas\\.(0|[1-9]\\d*)$`);
  let highestRevision = 0;
  for (const manifest of manifests) {
    const version = typeof manifest === "string" ? manifest : manifest?.version;
    const match = versionPattern.exec(version ?? "");
    if (!match) continue;
    const revision = Number(match[1]);
    highestRevision = Math.max(highestRevision, revision);
  }
  return { version: `${base}-alas.${highestRevision + 1}`, alreadyPublished: false };
}

export function prepareAlasPackage(packageJson, metadata) {
  for (const [key, value] of Object.entries({
    upstreamCommit: metadata?.upstreamCommit,
    sourceCommit: metadata?.sourceCommit,
  })) {
    if (!FULL_COMMIT.test(String(value ?? ""))) {
      throw new Error(`${key} must be a full 40-character git commit`);
    }
  }
  const upstreamVersion = stableVersion(metadata?.upstreamVersion);
  const { version } = selectAlasVersion({
    upstreamVersion,
    upstreamCommit: metadata.upstreamCommit,
    sourceCommit: metadata.sourceCommit,
    published: metadata.published,
  });
  return {
    ...packageJson,
    name: "@alas-ide/claude-agent-acp",
    version,
    homepage: "https://github.com/mrmans0n/claude-agent-acp#readme",
    bugs: { ...packageJson.bugs, url: "https://github.com/mrmans0n/claude-agent-acp/issues" },
    repository: {
      ...packageJson.repository,
      url: "git+https://github.com/mrmans0n/claude-agent-acp.git",
    },
    alasDownstream: {
      upstreamVersion,
      upstreamCommit: metadata.upstreamCommit,
      sourceCommit: metadata.sourceCommit,
    },
  };
}

function main() {
  const required = [
    "ALAS_UPSTREAM_VERSION",
    "ALAS_UPSTREAM_COMMIT",
    "ALAS_SOURCE_COMMIT",
    "ALAS_PUBLISHED_JSON",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }

  const packagePath = "package.json";
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const published = JSON.parse(process.env.ALAS_PUBLISHED_JSON);
  const prepared = prepareAlasPackage(packageJson, {
    upstreamVersion: process.env.ALAS_UPSTREAM_VERSION,
    upstreamCommit: process.env.ALAS_UPSTREAM_COMMIT,
    sourceCommit: process.env.ALAS_SOURCE_COMMIT,
    published,
  });
  writeFileSync(packagePath, `${JSON.stringify(prepared, null, 2)}\n`);
  const { alreadyPublished } = selectAlasVersion({
    upstreamVersion: process.env.ALAS_UPSTREAM_VERSION,
    upstreamCommit: process.env.ALAS_UPSTREAM_COMMIT,
    sourceCommit: process.env.ALAS_SOURCE_COMMIT,
    published,
  });
  process.stdout.write(`${JSON.stringify({ version: prepared.version, alreadyPublished })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
