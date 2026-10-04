import { describe, expect, it } from "vitest";
import { prepareAlasPackage, selectAlasVersion } from "./prepare-alas-package.mjs";

const sourceCommit = "a".repeat(40);
const upstreamCommit = "b".repeat(40);

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

  it("reuses a published version for the source commit before filtering by upstream base", () => {
    const published = [
      {
        version: "0.85.0-alas.7",
        alasDownstream: { sourceCommit, upstreamCommit: "c".repeat(40) },
      },
    ];
    expect(selectAlasVersion({ upstreamVersion: "0.85.1", sourceCommit, published })).toEqual({
      version: "0.85.0-alas.7",
      alreadyPublished: true,
    });
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
