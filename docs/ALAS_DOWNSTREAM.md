# Alas downstream publication

`mrmans0n/claude-agent-acp` maintains the protected `alas` branch and publishes
`@alas-ide/claude-agent-acp`. The committed manifest keeps the upstream package
name and stable version. The publication workflow rewrites the runner's manifest
to `X.Y.Z-alas.N` and records the upstream version, upstream commit, and protected
source commit.

The existing `0.85.1-alas.1` release is an immutable historical baseline. Its
ancestry is known to contain post-release upstream commits. Do not rebuild,
retag, or republish it. Exact-base enforcement applies to every newer stable
version.

## Protected branch and publication setup

Keep `alas` protected with reviewed pull requests, the strict Build check, one
approval, approval after the last push, deletion disabled, and history rewrites
disabled. Admins remain subject to the same rules. The `npm` environment accepts
deployments only from protected branches and has no required reviewers, so
dispatching the publication workflow is the publication decision.

Disable inherited upstream publication workflows in the fork. Alas publication
runs only through `.github/workflows/publish-alas.yml`, with OIDC provenance and
no npm token stored in Actions.

For the first package creation only, an npm maintainer may publish manually after
running all local gates and inspecting `npm pack --dry-run --json`. Configure the
npm trusted publisher immediately afterward for owner `mrmans0n`, repository
`claude-agent-acp`, workflow `publish-alas.yml`, and environment `npm`.

## Stable release agreement

A synchronization target must satisfy every condition below:

1. Its tag is stable `vX.Y.Z` and `X.Y.Z` is newer than the version in
   `package.json`.
2. GitHub has a release for that exact tag and the release is neither draft nor
   prerelease.
3. Upstream npm `latest` is exactly `X.Y.Z`.
4. The npm version's `gitHead`, when present, equals the tag commit.

`scripts/verify-upstream-release.mjs` enforces this agreement. Both the sync and
publish workflows call it. A disagreement stops the workflow before a candidate
or package can be promoted.

## Patch ledger and sync review

`docs/ALAS_DOWNSTREAM_PATCHES.json` records the downstream functional patches,
their original commits, upstream PRs, affected files, tests, and the last reviewed
stable base. Hotfix patches added after that sync belong in the ledger without
rewriting the historical sync review. The next sync audits them alongside the
existing patches.

The advisor-result patch from upstream PR #1247 completes server-side advisor
calls for plaintext, redacted, and error results. Its contract tests preserve the
failure for genuinely missing results and ensure encrypted advice is not emitted
to the client.

For each target release, `scripts/audit-downstream-patches.mjs` classifies every
patch:

- `unaffected`: no equivalent upstream patch and no changed patch path;
- `absorbed`: the stable tag contains an equivalent patch;
- `overlap`: upstream changed a patch path without equivalent behavior.

The workflow writes the audit to the committed
`docs/ALAS_SYNC_REVIEW.json`. The artifact records `fromTag`, `toTag`,
`toCommit`, every classification, and every resolution. `unaffected` patches are
auto-resolved as retained. `absorbed` and `overlap` remain unresolved until a
reviewer commits one of `retain`, `adapt`, or `drop`, plus a rationale and the
tests that support the choice. An `adapt` resolution also names the full commit
that contains the standalone replacement patch.

`scripts/sync-review.mjs` recomputes and verifies the artifact. The ledger's
`baseTag` advances only after the review is fully resolved. A rerun with no ledger
or review change skips the commit instead of failing.

## Building a reviewable synchronization PR

The workflow first builds an exact-tag candidate. It starts at the selected
stable tag, excludes later upstream commits, and reapplies downstream-only
commits deterministically.

Only edits from the canonical same-version branch
`sync/upstream-X.Y.Z` may be preserved automatically. Preserved sync-only commits
are listed in the review artifact and require explicit review. Older sync
branches are reported in the job summary and PR body but are not replayed.

A commit that changes only `ALAS_SYNC_REVIEW.json` or the patch ledger carries
review state rather than package content. The workflow reads and regenerates
that state instead of turning the metadata commit into another preserved edit.
This prevents a review-resolution commit from creating a new review item on
every rerun.

The exact candidate is not proposed directly against `alas`. The workflow creates
a deterministic integration commit:

- first parent: the freshly fetched protected `origin/alas` head;
- second parent: the exact-tag candidate;
- tree: the exact-tag candidate tree.

A rebuilt integration may keep the previous canonical sync head as a third
parent so reviewed branch history remains reachable. The first parent and tree
invariants do not change.

Before creating that commit, the workflow verifies that the old upstream base
reachable from `alas` is contained by the target stable tag. It then verifies
that the integration commit's merge-base with freshly fetched `upstream/main` is
exactly the target tag commit. If either condition fails, the workflow stops and
does not promote a branch.

Because the integration branch descends from `origin/alas`, its PR is reviewed
and merged normally under branch protection. Unresolved reviews remain draft.
Resolved reviews are marked ready and must pass the normal approval and Build
requirements.

Updates to an existing canonical sync branch use its previously fetched head as
a lease. A concurrent edit stops the update. Rebuilding the same inputs produces
the same integration commit, and a second rerun skips an unnecessary push.

## Durable failure reporting

Every sync and publish run writes `GITHUB_STEP_SUMMARY`, including failures that
occur before a detailed report is available. Audit output, preserved edits,
stale branches, integration failures, workflow-file changes, and unresolved
review items remain visible there.

When a canonical draft PR already exists, a failed sync updates its body with the
captured report when possible. GitHub Issues are not used for maintenance state.
No publication starts from the sync workflow.

## Manual publication

After the synchronization PR is approved, green, and merged, dispatch
**Publish Alas downstream** on `alas` with the exact protected head and stable
upstream tag:

```sh
gh workflow run publish-alas.yml --repo mrmans0n/claude-agent-acp --ref alas \
  -f source_commit="$(git rev-parse origin/alas)" \
  -f upstream_tag="v$(git show origin/alas:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")"
```

The workflow rejects a source SHA that differs from freshly fetched
`origin/alas`. It rechecks GitHub/npm release agreement, exact source merge-base,
the recomputed sync audit, the resolved review artifact, every preserved sync
commit found in source history, and the advanced ledger.
The ledger records each reviewed transition. Dropped commits remain retired,
adapted patches point to their replacement commit, and later syncs exclude
patch-equivalent cherry-picked copies of retired changes.
It then runs `npm ci`, formatting, lint, build, tests, and the tarball allowlist
before publishing with provenance.

The dependent release job creates `alas-v<version>` at the exact source commit.
Existing tags are accepted only when they already point to that commit. Published
versions and tags never move.

### Hotfix publication

A reviewed fork fix that cannot wait for the next stable upstream sync can be
republished on the upstream version of the latest publication. Dispatch with
`hotfix=true` and that publication's upstream tag:

```sh
gh workflow run publish-alas.yml --repo mrmans0n/claude-agent-acp --ref alas \
  -f source_commit="$(git rev-parse origin/alas)" \
  -f upstream_tag=vX.Y.Z -f hotfix=true
```

The prior publication is still verified against npm, its attestation, tag, and
release. Instead of the upstream release agreement, merge-base, and sync review
checks, `scripts/verify-alas-hotfix.mjs` then requires that:

- the declared tag matches `package.json` and the prior publication's upstream
  version and commit;
- the source descends from the prior publication's source; and
- `git merge-base SOURCE_COMMIT upstream/main` equals the prior source's
  merge-base, so the hotfix adds no upstream history.

Everything after the source gate is unchanged, and the next revision number is
allocated as usual. A hotfix inherits the upstream content of the publication it
builds on, including any upstream commits past the tag; it never adds more.

## Recovery

If npm publication succeeds but tag or release creation fails, rerun the failed
release job from the original Actions run. If a complete workflow rerun is still
valid, it must use the same source while that source remains the protected
`alas` head. Existing package metadata makes the upload step a no-op.

If a correction is required, merge a reviewed fix into `alas` and publish a new
`-alas.N` revision. Keep the previous package version, tag, release, and source
history intact.
