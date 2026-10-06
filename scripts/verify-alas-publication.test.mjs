import { describe, expect, it } from "vitest";
import {
  verifyGithubPublication,
  verifyInstalledPublication,
  verifyNpmPublication,
} from "./verify-alas-publication.mjs";

const sourceCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);
const version = "1.2.3-alas.4";
const integrityBytes = Buffer.from("exact-package-integrity");
const integrity = `sha512-${integrityBytes.toString("base64")}`;
const expectedRepository = "https://github.com/mrmans0n/claude-agent-acp";
const expectedWorkflowPath = ".github/workflows/publish-alas.yml";
const expectedWorkflowRef = "refs/heads/alas";

function attestation(source = sourceCommit) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/%40alas-ide/claude-agent-acp@${version}`,
        digest: { sha512: integrityBytes.toString("hex") },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            repository: expectedRepository,
            path: expectedWorkflowPath,
            ref: expectedWorkflowRef,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${expectedRepository}@${expectedWorkflowRef}`,
            digest: { gitCommit: source },
          },
        ],
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          dsseEnvelope: {
            payloadType: "application/vnd.in-toto+json",
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      },
    ],
  };
}

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
            url: `https://registry.npmjs.org/-/npm/v1/attestations/@alas-ide%2fclaude-agent-acp@${version}`,
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
        attestation: attestation(),
        expectedRepository,
        expectedWorkflowPath,
        expectedWorkflowRef,
      }),
    ).toEqual(expect.objectContaining({ version, integrity, sourceCommit }));
  });

  it("rejects provenance whose signed source commit does not match the protected source", () => {
    expect(() =>
      verifyNpmPublication({
        npmMetadata: npmMetadata(),
        packageName: "@alas-ide/claude-agent-acp",
        version,
        integrity,
        upstreamVersion: "1.2.3",
        upstreamCommit,
        sourceCommit,
        attestation: attestation("c".repeat(40)),
        expectedRepository,
        expectedWorkflowPath,
        expectedWorkflowRef,
      }),
    ).toThrow(/provenance.*source|source.*provenance/i);
  });

  it("verifies a historical protected anchor when a newer publication is latest", () => {
    const metadata = npmMetadata();
    metadata["dist-tags"].latest = "1.2.3-alas.5";

    expect(
      verifyNpmPublication({
        npmMetadata: metadata,
        packageName: "@alas-ide/claude-agent-acp",
        version,
        integrity,
        upstreamVersion: "1.2.3",
        upstreamCommit,
        sourceCommit,
        attestation: attestation(),
        expectedRepository,
        expectedWorkflowPath,
        expectedWorkflowRef,
        requireLatest: false,
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

describe("verifyInstalledPublication", () => {
  it("requires npm audit to verify the exact installed attestation bundle", () => {
    const packageName = "@alas-ide/claude-agent-acp";
    const attestationUrl = npmMetadata().versions[version].dist.attestations.url;
    const bundle = attestation();
    const lock = {
      packages: {
        "": { dependencies: { [packageName]: version } },
        [`node_modules/${packageName}`]: { version, integrity },
      },
    };
    const verified = {
      name: packageName,
      version,
      attestations: {
        url: attestationUrl,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: bundle.attestations,
    };
    expect(
      verifyInstalledPublication({
        packageName,
        version,
        integrity,
        attestationUrl,
        attestation: bundle,
        lock,
        audit: { invalid: [], missing: [], verified: [verified] },
      }),
    ).toEqual({ version, integrity });
    expect(() =>
      verifyInstalledPublication({
        packageName,
        version,
        integrity,
        attestationUrl,
        attestation: bundle,
        lock,
        audit: { invalid: [], missing: [], verified: [] },
      }),
    ).toThrow(/verified.*attestation|attestation.*verified/i);
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
