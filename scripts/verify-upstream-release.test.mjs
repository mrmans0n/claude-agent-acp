import { describe, expect, it } from "vitest";
import { verifyUpstreamRelease } from "./verify-upstream-release.mjs";

const commit = "a".repeat(40);

describe("verifyUpstreamRelease", () => {
  it("accepts a stable GitHub release that agrees with npm latest and gitHead", () => {
    expect(
      verifyUpstreamRelease({
        selectedTag: "v1.2.3",
        selectedCommit: commit,
        packageVersion: "1.1.0",
        githubRelease: {
          tag_name: "v1.2.3",
          draft: false,
          prerelease: false,
          target_commitish: commit,
        },
        npmMetadata: {
          "dist-tags": { latest: "1.2.3" },
          versions: { "1.2.3": { gitHead: commit } },
        },
      }),
    ).toEqual({ tag: "v1.2.3", version: "1.2.3", commit });
  });

  it.each([
    ["draft GitHub release", { draft: true }, {}, /draft/i],
    ["prerelease GitHub release", { prerelease: true }, {}, /prerelease/i],
    ["different GitHub tag", { tag_name: "v1.2.4" }, {}, /GitHub release tag/i],
    ["different npm latest", {}, { "dist-tags": { latest: "1.2.4" } }, /npm latest/i],
    ["missing npm version metadata", {}, { versions: {} }, /npm version metadata/i],
    [
      "different npm gitHead",
      {},
      { versions: { "1.2.3": { gitHead: "b".repeat(40) } } },
      /npm gitHead/i,
    ],
  ])("rejects %s", (_name, releasePatch, npmPatch, message) => {
    const githubRelease = {
      tag_name: "v1.2.3",
      draft: false,
      prerelease: false,
      target_commitish: commit,
      ...releasePatch,
    };
    const npmMetadata = {
      "dist-tags": { latest: "1.2.3" },
      versions: { "1.2.3": { gitHead: commit } },
      ...npmPatch,
    };
    expect(() =>
      verifyUpstreamRelease({
        selectedTag: "v1.2.3",
        selectedCommit: commit,
        packageVersion: "1.1.0",
        githubRelease,
        npmMetadata,
      }),
    ).toThrow(message);
  });

  it("accepts missing npm gitHead but rejects a tag that is not newer than package.json", () => {
    expect(
      verifyUpstreamRelease({
        selectedTag: "v1.2.3",
        selectedCommit: commit,
        packageVersion: "1.1.0",
        githubRelease: {
          tag_name: "v1.2.3",
          draft: false,
          prerelease: false,
          target_commitish: commit,
        },
        npmMetadata: {
          "dist-tags": { latest: "1.2.3" },
          versions: { "1.2.3": {} },
        },
      }),
    ).toEqual(expect.objectContaining({ version: "1.2.3" }));

    expect(() =>
      verifyUpstreamRelease({
        selectedTag: "v1.1.0",
        selectedCommit: commit,
        packageVersion: "1.1.0",
        githubRelease: {
          tag_name: "v1.1.0",
          draft: false,
          prerelease: false,
          target_commitish: commit,
        },
        npmMetadata: {
          "dist-tags": { latest: "1.1.0" },
          versions: { "1.1.0": {} },
        },
      }),
    ).toThrow(/newer than package version/i);

    expect(
      verifyUpstreamRelease({
        selectedTag: "v1.1.0",
        selectedCommit: commit,
        packageVersion: "1.1.0",
        requireNewer: false,
        githubRelease: {
          tag_name: "v1.1.0",
          draft: false,
          prerelease: false,
        },
        npmMetadata: {
          "dist-tags": { latest: "1.1.0" },
          versions: { "1.1.0": {} },
        },
      }),
    ).toEqual(expect.objectContaining({ version: "1.1.0" }));
  });
});
