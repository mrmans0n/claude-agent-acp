import assert from "node:assert/strict";
import { test } from "vitest";
import { selectUpstreamSync } from "./select-upstream-sync.mjs";

test("selects the newest stable tag by numeric semver order", () => {
  assert.deepEqual(
    selectUpstreamSync({
      tags: ["v2.9.9", "v2.10.0", "v1.99.99"],
      packageVersion: "2.0.0",
      openHeads: [],
    }),
    { tag: "v2.10.0", branch: "sync/upstream-2.10.0", staleHeads: [] },
  );
});

test("ignores prereleases and malformed versions", () => {
  assert.deepEqual(
    selectUpstreamSync({
      tags: ["v2.1.1", "v3.0.0-rc.1", "v3.0.0-preview.4", "v03.0.0", "unrelated"],
      packageVersion: "2.0.0",
      openHeads: [],
    }),
    { tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: [] },
  );
  assert.equal(
    selectUpstreamSync({
      tags: ["v3.0.0-rc.1"],
      packageVersion: "2.0.0",
      openHeads: [],
    }),
    null,
  );
});

test("selects only stable tags newer than the package version regardless of alas ancestry", () => {
  assert.equal(
    selectUpstreamSync({
      tags: [
        { name: "v2.1.0", merged: false },
        { name: "v2.1.1", merged: true },
      ],
      packageVersion: "2.1.1",
      openHeads: ["sync/upstream-2.1.0"],
    }),
    null,
  );
});

test("reuses the canonical head of an open sync PR", () => {
  assert.deepEqual(
    selectUpstreamSync({
      tags: ["v2.1.1"],
      packageVersion: "2.1.0",
      openHeads: ["sync/upstream-2.1.1", "feature/other"],
    }),
    { tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: [] },
  );
});

test("replaces older sync heads with the newest stable head", () => {
  assert.deepEqual(
    selectUpstreamSync({
      tags: ["v2.1.0", "v2.1.1"],
      packageVersion: "2.0.0",
      openHeads: ["sync/upstream-2.1.0", "feature/other", "sync/upstream-2.1.1"],
    }),
    { tag: "v2.1.1", branch: "sync/upstream-2.1.1", staleHeads: ["sync/upstream-2.1.0"] },
  );
});
