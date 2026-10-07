import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

const CLAUDE_PATCH_IDENTITIES = [
  {
    name: "goal-capability-opt-in",
    identityCommit: "60749d07ff50308ef96c5251152a8d4986fe680f",
    upstreamPr: 1245,
    files: ["docs/air-extensions.md", "src/acp-agent.ts", "src/goal-extension.ts"],
    tests: ["src/tests/acp-agent.test.ts"],
  },
  {
    name: "async-tasks-opt-in",
    identityCommit: "3e098c71628cc7d5927ee8a3d794faa433dce12d",
    upstreamPr: null,
    files: ["src/acp-agent.ts", "src/async-tasks.ts"],
    tests: ["src/tests/acp-agent.test.ts", "src/tests/async-tasks.test.ts"],
  },
  {
    name: "advisor-tool-results",
    identityCommit: "af55f8bdedebbc951352d68fba44d616cc4908cb",
    upstreamPr: 1247,
    files: ["src/acp-agent.ts"],
    tests: ["src/tests/incomplete-tools.test.ts"],
  },
];

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateClaudePatchIdentities(ledger) {
  const patches = ledger?.patches;
  const valid =
    Array.isArray(patches) &&
    patches.length === CLAUDE_PATCH_IDENTITIES.length &&
    CLAUDE_PATCH_IDENTITIES.every((identity, index) => {
      const patch = patches[index];
      return (
        patch?.name === identity.name &&
        patch.identityCommit === identity.identityCommit &&
        patch.upstreamPr === identity.upstreamPr &&
        sameJson(patch.files, identity.files) &&
        sameJson(patch.tests, identity.tests)
      );
    });
  if (!valid) {
    throw new Error(
      "Downstream patch ledger must contain exactly the known Claude functional patch identities",
    );
  }
}

function validateLedger(ledger, { enforceKnownIdentities = true } = {}) {
  if (ledger?.version !== 1 || !/^v\d+\.\d+\.\d+$/.test(ledger.baseTag ?? "")) {
    throw new Error("Downstream patch ledger must have version 1 and a stable baseTag");
  }
  if (!Array.isArray(ledger.patches) || ledger.patches.length === 0) {
    throw new Error("Downstream patch ledger must contain patches");
  }
  for (const patch of ledger.patches) {
    if (
      typeof patch.name !== "string" ||
      !/^[0-9a-f]{40}$/.test(patch.commit ?? "") ||
      !(patch.upstreamPr === null || Number.isInteger(patch.upstreamPr)) ||
      !Array.isArray(patch.files) ||
      patch.files.length === 0 ||
      !Array.isArray(patch.tests) ||
      patch.tests.length === 0 ||
      ![undefined, "active", "dropped"].includes(patch.disposition) ||
      !Array.isArray(patch.retiredCommits ?? []) ||
      !(patch.retiredCommits ?? []).every((commit) => /^[0-9a-f]{40}$/.test(commit))
    ) {
      throw new Error(`Invalid downstream patch ledger entry: ${patch?.name ?? "unnamed"}`);
    }
  }
  if (enforceKnownIdentities) validateClaudePatchIdentities(ledger);
}

function isEquivalent(cwd, targetRef, commit) {
  const parent = git(cwd, "rev-parse", `${commit}^`);
  const line = git(cwd, "cherry", targetRef, commit, parent);
  if (!line) throw new Error(`Unable to compare patch-id for ${commit}`);
  return line.startsWith("-");
}

export function auditDownstreamPatches({
  cwd,
  ledger,
  targetRef,
  targetTag = targetRef,
  baseRef = ledger?.baseTag,
  enforceKnownIdentities = true,
}) {
  validateLedger(ledger, { enforceKnownIdentities });
  const targetCommit = git(cwd, "rev-parse", "--verify", `${targetRef}^{commit}`);
  // The fork does not mirror upstream tags, so callers pass the fetched ref for the ledger's base tag.
  git(cwd, "rev-parse", "--verify", `${baseRef}^{commit}`);
  const changedFiles = new Set(
    git(cwd, "diff", "--name-only", `${baseRef}..${targetRef}`).split("\n").filter(Boolean),
  );
  const patches = ledger.patches
    .filter((patch) => patch.disposition !== "dropped")
    .map((patch) => {
      const equivalent = isEquivalent(cwd, targetRef, patch.commit);
      const overlappingFiles = patch.files.filter((path) => changedFiles.has(path));
      const status = equivalent
        ? "absorbed"
        : overlappingFiles.length > 0
          ? "overlap"
          : "unaffected";
      return { ...patch, status, equivalent, overlappingFiles };
    });
  return {
    baseTag: ledger.baseTag,
    targetRef: targetTag,
    targetCommit,
    manualReview: patches.some((patch) => patch.status !== "unaffected"),
    changedFiles: [...changedFiles].sort(),
    patches,
  };
}

export function renderPatchAuditMarkdown(result) {
  const lines = [
    `## Downstream patch audit: ${result.baseTag} → ${result.targetRef}`,
    "",
    "| Patch | Upstream PR | Classification | Overlapping paths |",
    "| --- | --- | --- | --- |",
  ];
  for (const patch of result.patches) {
    lines.push(
      `| ${patch.name} | ${patch.upstreamPr === null ? "not submitted" : `#${patch.upstreamPr}`} | **${patch.status}** | ${patch.overlappingFiles.join("<br>") || "—"} |`,
    );
  }
  lines.push(
    "",
    result.manualReview
      ? "Manual review is required. The sync candidate was not updated automatically."
      : "All downstream patches are unaffected by the stable upstream range.",
  );
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cwd = resolve(args.cwd ?? ".");
  const ledgerPath = resolve(cwd, args.ledger ?? "docs/ALAS_DOWNSTREAM_PATCHES.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const result = auditDownstreamPatches({
    cwd,
    ledger,
    targetRef: args["target-ref"],
    targetTag: args["target-tag"] ?? args["target-ref"],
    baseRef: args["base-ref"] ?? ledger.baseTag,
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  const markdown = renderPatchAuditMarkdown(result);
  if (args.json) writeFileSync(resolve(args.json), json);
  if (args.markdown) writeFileSync(resolve(args.markdown), markdown);
  process.stdout.write(json);
  if (result.manualReview) process.exitCode = 2;
}
