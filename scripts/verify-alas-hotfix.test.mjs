import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAlasHotfix } from "./verify-alas-hotfix.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function commitFile(cwd, path, contents, message) {
  writeFileSync(join(cwd, path), contents);
  git(cwd, "add", path);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

describe("verifyAlasHotfix", () => {
  let f;

  beforeAll(() => {
    const cwd = mkdtempSync(join(tmpdir(), "alas-hotfix-"));
    git(cwd, "init", "-b", "upstream");
    git(cwd, "config", "user.name", "Fixture");
    git(cwd, "config", "user.email", "fixture@example.test");
    const stable = commitFile(cwd, "package.json", '{"version":"0.85.1"}\n', "stable");
    git(cwd, "tag", "v0.85.1");
    const preview = commitFile(cwd, "preview.txt", "preview\n", "post-stable upstream");
    git(cwd, "checkout", "-b", "alas", preview);
    const prior = commitFile(cwd, "downstream.txt", "downstream\n", "downstream");
    const hotfix = commitFile(cwd, "hotfix.txt", "hotfix\n", "hotfix");
    git(cwd, "checkout", "upstream");
    commitFile(cwd, "later.txt", "later\n", "later upstream");
    git(cwd, "checkout", "-b", "contaminated", hotfix);
    git(cwd, "merge", "--no-ff", "upstream", "-m", "merge upstream main");
    const contaminated = git(cwd, "rev-parse", "HEAD");
    git(cwd, "checkout", "-b", "unrelated", stable);
    const unrelated = commitFile(cwd, "other.txt", "other\n", "unrelated");
    f = { cwd, stable, preview, prior, hotfix, contaminated, unrelated };
  });

  afterAll(() => {
    rmSync(f.cwd, { recursive: true, force: true });
  });

  const verify = (overrides = {}) =>
    verifyAlasHotfix({
      cwd: f.cwd,
      sourceCommit: f.hotfix,
      priorSourceCommit: f.prior,
      priorUpstreamVersion: "0.85.1",
      priorUpstreamCommit: f.stable,
      upstreamMainRef: "upstream",
      stableTagRef: "v0.85.1",
      declaredTag: "v0.85.1",
      packageVersion: "0.85.1",
      ...overrides,
    });

  it("accepts fork commits on top of the prior publication, keeping its upstream history", () => {
    expect(verify()).toEqual({
      sourceCommit: f.hotfix,
      declaredTag: "v0.85.1",
      stableCommit: f.stable,
      priorSourceCommit: f.prior,
      mergeBase: f.preview,
    });
  });

  it("accepts a rerun of the source that is already the prior publication", () => {
    expect(verify({ sourceCommit: f.prior }).mergeBase).toBe(f.preview);
  });

  it.each([
    [
      "a package version other than the tag",
      () => ({ packageVersion: "0.85.2" }),
      /does not match package version/,
    ],
    [
      "a prior publication on another upstream version",
      () => ({ priorUpstreamVersion: "0.85.0" }),
      /Prior publication is based on v0\.85\.0/,
    ],
    [
      "a prior publication on another upstream commit",
      () => ({ priorUpstreamCommit: f.preview }),
      /Prior publication is based on/,
    ],
    [
      "a source that does not descend from the prior publication",
      () => ({ sourceCommit: f.unrelated }),
      /does not descend from prior publication source/,
    ],
    [
      "new upstream history",
      () => ({ sourceCommit: f.contaminated }),
      /brings in upstream history/,
    ],
  ])("rejects %s", (_name, overrides, error) => {
    expect(() => verify(overrides())).toThrow(error);
  });
});
