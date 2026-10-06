import { describe, expect, it } from "vitest";
import * as packagePreparation from "./prepare-alas-package.mjs";

const { prepareAlasPackage, selectAlasVersion } = packagePreparation;

const sourceCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);

describe("selectPublicationAnchor", () => {
  it("exports the publication anchor selector", () => {
    expect(packagePreparation.selectPublicationAnchor).toBeTypeOf("function");
  });

  it("uses npm latest when it belongs to an earlier protected source", () => {
    const previousSource = "c".repeat(40);
    const published = {
      "dist-tags": { latest: "0.85.1-alas.2" },
      versions: {
        "0.85.1-alas.2": {
          dist: {
            integrity: "sha512-previous",
            attestations: { url: "https://registry.example/previous" },
          },
          alasDownstream: {
            sourceCommit: previousSource,
            upstreamCommit,
            upstreamVersion: "0.85.1",
          },
        },
      },
    };

    expect(packagePreparation.selectPublicationAnchor({ published, sourceCommit })).toEqual({
      version: "0.85.1-alas.2",
      integrity: "sha512-previous",
      sourceCommit: previousSource,
      upstreamCommit,
      upstreamVersion: "0.85.1",
    });
  });

  it("uses the most recent earlier source when npm latest is the publication being rerun", () => {
    const previousSource = "c".repeat(40);
    const olderSource = "d".repeat(40);
    const published = {
      "dist-tags": { latest: "0.86.0-alas.1" },
      time: {
        "0.85.1-alas.1": "2026-10-05T01:00:00.000Z",
        "0.85.1-alas.2": "2026-10-05T02:00:00.000Z",
        "0.86.0-alas.1": "2026-10-05T03:00:00.000Z",
      },
      versions: {
        "0.85.1-alas.1": {
          dist: {
            integrity: "sha512-older",
            attestations: { url: "https://registry.example/older" },
          },
          alasDownstream: {
            sourceCommit: olderSource,
            upstreamCommit,
            upstreamVersion: "0.85.1",
          },
        },
        "0.85.1-alas.2": {
          dist: {
            integrity: "sha512-previous",
            attestations: { url: "https://registry.example/previous" },
          },
          alasDownstream: {
            sourceCommit: previousSource,
            upstreamCommit,
            upstreamVersion: "0.85.1",
          },
        },
        "0.86.0-alas.1": {
          dist: {
            integrity: "sha512-current",
            attestations: { url: "https://registry.example/current" },
          },
          alasDownstream: {
            sourceCommit,
            upstreamCommit: "e".repeat(40),
            upstreamVersion: "0.86.0",
          },
        },
      },
    };

    expect(packagePreparation.selectPublicationAnchor({ published, sourceCommit })).toEqual({
      version: "0.85.1-alas.2",
      integrity: "sha512-previous",
      sourceCommit: previousSource,
      upstreamCommit,
      upstreamVersion: "0.85.1",
    });
  });

  it("fails closed when a rerun has no earlier attested publication anchor", () => {
    const published = {
      "dist-tags": { latest: "0.86.0-alas.1" },
      time: { "0.86.0-alas.1": "2026-10-05T03:00:00.000Z" },
      versions: {
        "0.86.0-alas.1": {
          dist: {
            integrity: "sha512-current",
            attestations: { url: "https://registry.example/current" },
          },
          alasDownstream: {
            sourceCommit,
            upstreamCommit,
            upstreamVersion: "0.86.0",
          },
        },
      },
    };

    expect(() => packagePreparation.selectPublicationAnchor({ published, sourceCommit })).toThrow(
      /no earlier protected publication anchor/i,
    );
  });

  it("skips a verified incomplete latest publication when selecting the protected anchor", () => {
    const previousSource = "c".repeat(40);
    const partialSource = "d".repeat(40);
    const published = {
      "dist-tags": { latest: "0.86.0-alas.2" },
      time: {
        "0.86.0-alas.1": "2026-10-05T22:00:00.000Z",
        "0.86.0-alas.2": "2026-10-06T16:00:00.000Z",
      },
      versions: {
        "0.86.0-alas.1": {
          dist: {
            integrity: "sha512-previous",
            attestations: { url: "https://registry.example/previous" },
          },
          alasDownstream: {
            sourceCommit: previousSource,
            upstreamCommit,
            upstreamVersion: "0.86.0",
          },
        },
        "0.86.0-alas.2": {
          dist: {
            integrity: "sha512-partial",
            attestations: { url: "https://registry.example/partial" },
          },
          alasDownstream: {
            sourceCommit: partialSource,
            upstreamCommit,
            upstreamVersion: "0.86.0",
          },
        },
      },
    };

    expect(
      packagePreparation.selectPublicationAnchor({
        published,
        sourceCommit,
        excludedVersions: ["0.86.0-alas.2"],
      }),
    ).toEqual({
      version: "0.86.0-alas.1",
      integrity: "sha512-previous",
      sourceCommit: previousSource,
      upstreamCommit,
      upstreamVersion: "0.86.0",
    });
  });
});

describe("selectAlasVersion", () => {
  it("starts the first downstream revision at one", () => {
    expect(
      selectAlasVersion({ upstreamVersion: "0.85.1", sourceCommit, published: [] }).version,
    ).toBe("0.85.1-alas.1");
  });

  it("increments revisions for the same upstream base", () => {
    const selected = selectAlasVersion({
      upstreamVersion: "0.85.1",
      sourceCommit,
      published: [
        { version: "0.85.1-alas.1", alasDownstream: { sourceCommit: "c".repeat(40) } },
        { version: "0.85.1-alas.2", alasDownstream: { sourceCommit: "d".repeat(40) } },
      ],
    });
    expect(selected.version).toBe("0.85.1-alas.3");
    expect(selected.alreadyPublished).toBe(false);
  });

  it("does not count revisions from another upstream base", () => {
    expect(
      selectAlasVersion({
        upstreamVersion: "0.85.1",
        sourceCommit,
        published: [
          { version: "0.85.0-alas.12", alasDownstream: { sourceCommit: "c".repeat(40) } },
          { version: "0.86.0-alas.4", alasDownstream: { sourceCommit: "d".repeat(40) } },
        ],
      }).version,
    ).toBe("0.85.1-alas.1");
  });

  it("reuses only an exact prior publication for the same source and upstream identity", () => {
    const published = [
      {
        version: "0.85.1-alas.7",
        alasDownstream: { sourceCommit, upstreamCommit, upstreamVersion: "0.85.1" },
      },
    ];
    expect(
      selectAlasVersion({ upstreamVersion: "0.85.1", upstreamCommit, sourceCommit, published }),
    ).toEqual({
      version: "0.85.1-alas.7",
      alreadyPublished: true,
    });
  });

  it("rejects a historical publication whose source metadata belongs to another upstream", () => {
    const published = [
      {
        version: "0.85.0-alas.7",
        alasDownstream: {
          sourceCommit,
          upstreamCommit: "c".repeat(40),
          upstreamVersion: "0.85.0",
        },
      },
    ];
    expect(() =>
      selectAlasVersion({ upstreamVersion: "0.85.1", upstreamCommit, sourceCommit, published }),
    ).toThrow(/historical|metadata|upstream/i);
  });

  it("requires a full source commit hash", () => {
    expect(() =>
      selectAlasVersion({ upstreamVersion: "0.85.1", sourceCommit: "abc1234", published: [] }),
    ).toThrow(/40-character/);
  });
});

describe("prepareAlasPackage", () => {
  const upstreamPackage = {
    name: "@agentclientprotocol/claude-agent-acp",
    version: "0.85.1",
    main: "dist/lib.js",
    types: "dist/lib.d.ts",
    bin: { "claude-agent-acp": "dist/index.js" },
    exports: { ".": { types: "./dist/lib.d.ts", import: "./dist/lib.js" }, "./*": "./*" },
    files: ["dist/", "!dist/tests/", "README.md", "LICENSE", "package.json"],
    repository: {
      type: "git",
      url: "git+https://github.com/agentclientprotocol/claude-agent-acp.git",
    },
    homepage: "https://github.com/agentclientprotocol/claude-agent-acp#readme",
    bugs: { url: "https://github.com/agentclientprotocol/claude-agent-acp/issues" },
  };
  const metadata = { upstreamVersion: "0.85.1", upstreamCommit, sourceCommit, published: [] };

  it("prepares the Claude package without changing its entry points or publish files", () => {
    const prepared = prepareAlasPackage(upstreamPackage, metadata);
    expect(prepared.name).toBe("@alas-ide/claude-agent-acp");
    expect(prepared.bin["claude-agent-acp"]).toBe("dist/index.js");
    expect(prepared.exports).toEqual(upstreamPackage.exports);
    expect(prepared.types).toBe(upstreamPackage.types);
    expect(prepared.files).toEqual(upstreamPackage.files);
    expect(prepared.files).toContain("!dist/tests/");
    expect(prepared.repository.url).toBe("git+https://github.com/mrmans0n/claude-agent-acp.git");
    expect(prepared.homepage).toBe("https://github.com/mrmans0n/claude-agent-acp#readme");
    expect(prepared.bugs.url).toBe("https://github.com/mrmans0n/claude-agent-acp/issues");
    expect(prepared.alasDownstream).toEqual({
      upstreamVersion: "0.85.1",
      upstreamCommit,
      sourceCommit,
    });
    expect(upstreamPackage.name).toBe("@agentclientprotocol/claude-agent-acp");
  });

  it("requires full upstream and source commit hashes", () => {
    expect(() =>
      prepareAlasPackage(upstreamPackage, { ...metadata, upstreamCommit: "short" }),
    ).toThrow(/40-character/);
    expect(() =>
      prepareAlasPackage(upstreamPackage, { ...metadata, sourceCommit: "short" }),
    ).toThrow(/40-character/);
  });
});
