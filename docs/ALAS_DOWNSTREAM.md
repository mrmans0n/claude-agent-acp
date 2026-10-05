# Alas downstream publication

`mrmans0n/claude-agent-acp` maintains the `alas` branch and publishes
`@alas-ide/claude-agent-acp`. The committed manifest keeps the upstream package name
and stable version. Publication changes only the runner's manifest to
`X.Y.Z-alas.N` and records `alasDownstream.upstreamVersion`, `upstreamCommit`,
and `sourceCommit`. The upstream commit is the canonical `vX.Y.Z` tag's commit;
it must be the **exact** merge-base between the selected source and freshly
fetched `upstream/main`. Merely being an ancestor is not sufficient. The initial
upstream base is `v0.85.1`.

`docs/ALAS_DOWNSTREAM_PATCHES.json` is the versioned source of truth for the two
functional downstream patches. Each entry records its original commit, upstream
PR (or explicit `null` when none exists), affected files, and tests. The ledger's
`baseTag` is the last stable tag against which every patch was reviewed.

## First publication

1. Protect `alas`: require reviewed pull requests and passing checks, block
   force pushes and deletion, and restrict direct pushes. Configure the `npm`
   GitHub environment to allow deployments only from `alas` and require a
   maintainer approval. Put `ci.yml`, `sync-upstream.yml`, and `publish-alas.yml`
   on the fork's default branch, or make `alas` the default branch. GitHub discovers
   scheduled and manually dispatched workflows from the default branch. Enable
   these three downstream workflows and allow Actions to create pull requests.
   Keep `ci.yml` and the sync helper on `alas` too. Disable inherited upstream
   release automation, including `publish.yml`, so upstream preview and stable
   releases cannot publish from the fork. Publishing Alas is manual.
2. An npm maintainer with access to the `@alas-ide` scope signs in with 2FA.
   Check out the reviewed `alas` head, then prepare the first package:

   ```sh
   npm ci && npm run format:check && npm run lint && npm run build && npm run test:run
   upstream_version="$(node -p "require('./package.json').version")"
   git fetch https://github.com/agentclientprotocol/claude-agent-acp.git \
     "+refs/heads/main:refs/remotes/alas-upstream/main" \
     "refs/tags/v$upstream_version:refs/alas-upstream"
   upstream_commit="$(git rev-list -n 1 refs/alas-upstream)"
   test "$(git merge-base HEAD refs/remotes/alas-upstream/main)" = "$upstream_commit"
   ALAS_UPSTREAM_VERSION="$upstream_version" \
   ALAS_UPSTREAM_COMMIT="$upstream_commit" \
   ALAS_SOURCE_COMMIT="$(git rev-parse HEAD)" \
   ALAS_PUBLISHED_JSON='[]' node scripts/prepare-alas-package.mjs
   npm pack --dry-run --json
   ```

   Stop on any failed command. Inspect the rewritten manifest and ensure the
   tarball includes `dist/index.js`, `dist/lib.js`, and `dist/lib.d.ts`. It must
   contain only `dist/` files outside `dist/tests/`, `README.md`, `LICENSE`, and
   `package.json` before publishing. Use empty registry metadata only when the
   package has never been published.

3. Run `npm publish --access public --tag latest` and complete npm's 2FA prompt. This one-time
   publication creates the package so its trusted publisher can be configured.
   Run `git restore -- package.json` afterward; never commit the publication
   rewrite.
4. In the npm package's trusted publisher settings, choose GitHub Actions with
   owner `mrmans0n`, repository `claude-agent-acp`, workflow `publish-alas.yml`, and
   environment `npm`, and grant direct publication permission. The later workflow
   publishes with provenance through OIDC. In package publishing access settings,
   require 2FA and disallow traditional publish tokens. Never store an npm publish
   token in GitHub Actions. Both manual and automated publications set `--tag latest`
   so normal installs receive the downstream version even though `-alas.N` is a
   semver prerelease.
5. Dispatch the workflow for the same source commit to create its tag and
   release. It reads the published metadata and skips the npm upload.

## Manual publication

Dispatch **Publish Alas downstream** on branch `alas`, with `source_commit` set
to the full 40-character SHA of the current protected branch head:

```sh
gh workflow run publish-alas.yml --repo mrmans0n/claude-agent-acp --ref alas \
  -f source_commit="$(git rev-parse HEAD)" \
  -f upstream_tag="v$(node -p "require('./package.json').version")"
```

Use this only from a checkout at the intended `alas` head. The workflow rejects
other branches and a source SHA that differs from freshly fetched `origin/alas`.
It also rejects a non-stable declared tag, a tag that disagrees with the package
version, or any source whose merge-base with freshly fetched `upstream/main` is
not exactly the declared tag commit. This rejects preview or post-release
upstream contamination. It runs Node 24, checks the committed lockfile before rewriting the manifest,
and requires `dist/index.js`, `dist/lib.js`, and `dist/lib.d.ts` in the tarball.
Every packed path must belong to the manifest's `files` allowlist, with
`dist/tests/` excluded. Workflow runs serialize so version allocation and npm
publication do not race. GitHub may replace an older pending run with a newer
one; dispatch the intended commit again if needed.

The npm job has only `contents: read` and `id-token: write`. The dependent tag
and release job has only `contents: write`. A successful upload or an already
published source always hands the resolved version to that job. Tags use
`alas-v<version>` and point to the exact source commit. Release notes record the
upstream tag, upstream commit, and source commit.

## Upstream synchronization and manual fallback

The daily workflow never merges a stable tag into the existing `alas` history.
That history may contain upstream preview commits after its declared stable base.
Instead, `scripts/build-sync-candidate.mjs` starts a replacement candidate at the
exact stable tag and cherry-picks only commits reachable from `alas` that are not
reachable from freshly fetched `upstream/main`. This retains downstream work but
excludes upstream preview and post-stable commits that happened to be ancestors
of the old branch.

Before rebuilding, `scripts/audit-downstream-patches.mjs` compares every ledger
entry with the new stable tag by Git patch-id equivalence and compares the
ledger's paths with upstream paths changed since `baseTag`:

- `unaffected`: no equivalent upstream patch and no changed ledger path;
- `absorbed`: an equivalent patch-id is already in the stable tag;
- `overlap`: no equivalent patch, but upstream changed at least one ledger path.

Only an all-`unaffected` result can produce an automated candidate. `absorbed`
and `overlap` stop the job with a failed status and a complete job summary. If a
canonical sync PR already exists, it is retained as a draft and its body is
updated with the audit. Reviewers must decide whether to remove, rewrite, or
retest the patch and update the ledger before rerunning. Publication is never
triggered by synchronization.

Sync-only maintainer commits from the canonical and older sync branches are
reapplied after downstream commits. Every fetched sync head is recorded by exact
SHA. An existing candidate is replaced only with
`--force-with-lease=<recorded SHA>`; a concurrent push makes the update fail
closed. Older sync PRs and branches are not automatically closed or deleted.

The workflow has no GitHub Issues permission and never calls `gh issue`. Patch
review, cherry-pick conflicts, and workflow-file changes are reported in the job
summary and fail the job. A successfully built candidate is kept in a persistent
draft PR. The `GITHUB_TOKEN` does not push a candidate when the resulting tree
changes `.github/workflows`.

### Reviewing and installing a candidate

The draft PR is a review surface, not a normal merge vehicle. A normal merge,
squash, or rebase into `alas` would retain the old contaminated ancestry and make
the publication merge-base gate fail. After CI and human review succeed, a
maintainer must replace `alas` with the exact candidate head using a lease:

```sh
tag=vX.Y.Z
branch="sync/upstream-${tag#v}"
git fetch origin "$branch" alas
candidate="$(git rev-parse "origin/$branch")"
expected_alas="$(git rev-parse origin/alas)"
git fetch --no-tags https://github.com/agentclientprotocol/claude-agent-acp.git \
  "+refs/heads/main:refs/remotes/alas-upstream/main" \
  "+refs/tags/$tag:refs/alas-upstream-tags/$tag"
test "$(git merge-base "$candidate" refs/remotes/alas-upstream/main)" = \
  "$(git rev-parse "refs/alas-upstream-tags/$tag^{commit}")"
git push origin "$candidate:refs/heads/alas" \
  "--force-with-lease=refs/heads/alas:$expected_alas"
```

Branch protection may need a temporary, explicitly reviewed maintainer bypass
for that single lease-protected replacement. Restore the protection immediately,
verify `origin/alas` equals the reviewed candidate, then close the draft PR. Do
not merge the PR through GitHub's merge button.

For conflicts or workflow changes, reproduce the candidate locally with the refs
and SHAs shown in the job summary. Preserve every sync-only commit, resolve the
conflict, run `npm ci`, `npm run format:check`, `npm run lint`, `npm run build`,
`npm run test:run`, and the script/workflow tests, then push with an exact
force-with-lease. Never replace a branch whose fetched head has moved.

The already published `0.85.1-alas.1` remains immutable historical output. Do
not attempt to repair or republish it; the stricter gates apply to later versions.

## Recovery and rollback

If npm publication succeeds but tagging or release creation fails, rerun the
workflow for the same source while it remains the `alas` head. Its npm metadata
reuses the existing version and skips publishing. An existing matching tag and
release are accepted; a tag pointing elsewhere stops the job and is never moved.
If the branch has advanced, rerun only the failed release job in the original
Actions run, which retains the successful publish job's source and version.
Do not dispatch an old commit against a newer branch head.

A registry lookup error other than package-not-found stops publication. Do not
substitute empty metadata after a network or authentication failure. If an
upload's outcome is uncertain, wait until npm exposes the manifest before
rerunning. Never publish an existing version again or move a release tag.

Rollback by reverting the faulty change in a reviewed `alas` commit and
publishing a new revision. Update consumers to the resulting exact version.
Keep the old version and tag for reproducibility; npm versions are immutable.

## Retirement

Retire the downstream when upstream includes the required behavior and Alas
can use a tested upstream release, or when Alas no longer uses this adapter.
Switch consumers first, disable `publish-alas.yml`, and remove the npm trusted
publisher. Preserve published versions, tags, and their source history so
existing pinned installations remain reproducible.
