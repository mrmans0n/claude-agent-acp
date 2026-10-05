import { describe, expect, it } from "vitest";
import { verifyGithubPublication, verifyNpmPublication } from "./verify-alas-publication.mjs";

const sourceCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);
const version = "1.2.3-alas.4";
const integrity = "sha512-exact-integrity";

function npmMetadata() {
  return {
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name: "@alas-ide/claude-agent-acp",
        version,
        alasDownstream: {
          upstreamVersion: "1.2.3",
          upstreamCommit,
          sourceCommit,
        },
        dist: {
          integrity,
          attestations: {
            url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
        },
      },
    },
  };
}

describe("verifyNpmPublication", () => {
  it("verifies the exact published version, latest tag, integrity, metadata, and provenance", () => {
    expect(
      verifyNpmPublication({
        npmMetadata: npmMetadata(),
        packageName: "@alas-ide/claude-agent-acp",
        version,
        integrity,
        upstreamVersion: "1.2.3",
        upstreamCommit,
        sourceCommit,
      }),
    ).toEqual(expect.objectContaining({ version, integrity, sourceCommit }));
  });

  it.each([
    ["latest", (metadata) => (metadata["dist-tags"].latest = "1.2.3-alas.3")],
    ["version", (metadata) => delete metadata.versions[version]],
    ["integrity", (metadata) => (metadata.versions[version].dist.integrity = "sha512-other")],
    [
      "source metadata",
      (metadata) => (metadata.versions[version].alasDownstream.sourceCommit = "c".repeat(40)),
    ],
    ["attestations", (metadata) => delete metadata.versions[version].dist.attestations],
    ["provenance", (metadata) => delete metadata.versions[version].dist.attestations.provenance],
  ])("rejects mismatched or missing %s", (_label, mutate) => {
    const metadata = npmMetadata();
    mutate(metadata);
    expect(() =>
      verifyNpmPublication({
        npmMetadata: metadata,
        packageName: "@alas-ide/claude-agent-acp",
        version,
        integrity,
        upstreamVersion: "1.2.3",
        upstreamCommit,
        sourceCommit,
      }),
    ).toThrow();
  });
});

describe("verifyGithubPublication", () => {
  const tag = `alas-v${version}`;
  const expectedNotes = `npm: @alas-ide/claude-agent-acp@${version}. Upstream tag: v1.2.3. Upstream commit: ${upstreamCommit}. Source commit: ${sourceCommit}.`;

  it("verifies the exact immutable tag and release target, source, and version", () => {
    expect(
      verifyGithubPublication({
        tag,
        version,
        sourceCommit,
        upstreamVersion: "1.2.3",
        upstreamCommit,
        tagRef: { ref: `refs/tags/${tag}`, object: { type: "commit", sha: sourceCommit } },
        release: {
          tag_name: tag,
          target_commitish: sourceCommit,
          draft: false,
          prerelease: false,
          body: expectedNotes,
        },
      }),
    ).toEqual(expect.objectContaining({ tag, version, sourceCommit }));
  });

  it.each([
    ["tag target", (tagRef) => (tagRef.object.sha = "c".repeat(40)), (_release) => {}],
    ["release target", (_tagRef) => {}, (release) => (release.target_commitish = "alas")],
    [
      "release source",
      (_tagRef) => {},
      (release) => (release.body = release.body.replace(sourceCommit, "c".repeat(40))),
    ],
    [
      "release version",
      (_tagRef) => {},
      (release) => (release.body = release.body.replace(version, "1.2.3-alas.3")),
    ],
  ])("rejects a mismatched %s", (_label, mutateTag, mutateRelease) => {
    const tagRef = { ref: `refs/tags/${tag}`, object: { type: "commit", sha: sourceCommit } };
    const release = {
      tag_name: tag,
      target_commitish: sourceCommit,
      draft: false,
      prerelease: false,
      body: expectedNotes,
    };
    mutateTag(tagRef);
    mutateRelease(release);
    expect(() =>
      verifyGithubPublication({
        tag,
        version,
        sourceCommit,
        upstreamVersion: "1.2.3",
        upstreamCommit,
        tagRef,
        release,
      }),
    ).toThrow();
  });
});
