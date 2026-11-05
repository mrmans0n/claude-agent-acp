import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_FILE_CHANGE_REPORT_MAX_BYTES,
  agentFileChangeReportForm,
  agentFileChangeReportMeta,
  agentFileChangeReportRequestId,
  createNativeFileChangeReporter,
  type AgentFileChangeReportForm,
  type AgentFileChangeReportResult,
  NEUTRAL_AGENT_FILE_CHANGE_REPORT_UNCERTAINTY,
  type NativeFileChangeReporter,
  recordSubagentFileEdits,
} from "../file-change-audit.js";

function createSupport(options: {
  form?: AgentFileChangeReportForm;
  cwd?: string;
  additionalDirectories?: string[];
  publish?: (result: AgentFileChangeReportResult) => Promise<void>;
  logError?: (message: string) => void;
  timeoutMs?: number;
}) {
  return createNativeFileChangeReporter({
    form: options.form ?? "air",
    cwd: options.cwd ?? process.cwd(),
    additionalDirectories: options.additionalDirectories ?? [],
    publish: options.publish ?? (async () => {}),
    logError: options.logError ?? (() => {}),
    timeoutMs: options.timeoutMs,
  });
}

function requestedTurn(
  reporter: NativeFileChangeReporter,
  requestId: string,
  editedPaths?: string[],
  form: AgentFileChangeReportForm = "air",
) {
  const request = { version: 1, requestId };
  const fileChangeReport = reporter.request(
    form === "neutral"
      ? { agentFileChangeReportRequest: request }
      : { jetbrains: { air: { agentFileChangeReportRequest: request } } },
  );
  expect(fileChangeReport).toBeDefined();
  return {
    promptUuid: "prompt-uuid",
    fileChangeReport,
    ...(editedPaths ? { editedPaths: new Set(editedPaths) } : {}),
  };
}

const MALFORMED_REQUESTS = [
  { version: 2, requestId: "turn-42" },
  { version: 1, requestId: "contains spaces" },
  { version: 1, requestId: "x".repeat(129) },
  { version: 1 },
  { version: 1, requestId: "turn-42", extra: true },
  null,
];

describe("native agent file-change report", () => {
  it("accepts only the versioned prompt request shape", () => {
    expect(
      agentFileChangeReportRequestId(
        {
          jetbrains: {
            air: {
              agentFileChangeReportRequest: { version: 1, requestId: "turn:42_a-b.c" },
            },
          },
        },
        "air",
      ),
    ).toBe("turn:42_a-b.c");

    for (const request of MALFORMED_REQUESTS) {
      expect(
        agentFileChangeReportRequestId(
          { jetbrains: { air: { agentFileChangeReportRequest: request } } },
          "air",
        ),
      ).toBeUndefined();
    }
  });

  it("owns request-id deduplication for the session", () => {
    const reporter = createSupport({});
    const turn = requestedTurn(reporter, "request-deduplicated");

    expect(turn.fileChangeReport?.requestId).toBe("request-deduplicated");
    expect(
      reporter.request({
        jetbrains: {
          air: {
            agentFileChangeReportRequest: {
              version: 1,
              requestId: "request-deduplicated",
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("uses Claude checkpoint dry-run and normalizes its paths", async () => {
    const cwd = path.join(os.tmpdir(), "native-file-report-project");
    const additionalRoot = path.join(os.tmpdir(), "native-file-report-shared");
    const canonicalTempRoot = fs.realpathSync.native(os.tmpdir());
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      cwd,
      additionalDirectories: [additionalRoot],
      publish: async (result) => void published.push(result),
    });
    const turn = requestedTurn(support, "request-1");
    const rewindFiles = vi.fn(async () => ({
      canRewind: true,
      filesChanged: ["src/a.ts", "src/a.ts", path.join(additionalRoot, "generated.ts")],
      insertions: 12,
      deletions: 3,
    }));

    await support.report(turn, { rewindFiles });

    expect(rewindFiles).toHaveBeenCalledWith("prompt-uuid", { dryRun: true });
    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-1",
        status: "reported",
        paths: [
          path.join(canonicalTempRoot, "native-file-report-project", "src/a.ts"),
          path.join(canonicalTempRoot, "native-file-report-shared", "generated.ts"),
        ],
        declaredComplete: false,
        truncated: false,
      },
    ]);
    expect(turn.fileChangeReport?.phase).toBe("finished");
  });

  it("publishes unavailable when Claude cannot preview the checkpoint", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({ publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-invalid");

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({ canRewind: false, error: "checkpoint missing" })),
    });

    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-invalid",
        status: "unavailable",
        reason: "invalidOutput",
      },
    ]);
  });

  it("times out fail-open and publishes only one terminal", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      publish: async (result) => void published.push(result),
      timeoutMs: 1,
    });
    const turn = requestedTurn(support, "request-timeout");
    const never = new Promise<never>(() => {});

    await support.report(turn, { rewindFiles: vi.fn(() => never) });
    support.finish(turn.fileChangeReport, "cancelled");

    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-timeout",
        status: "unavailable",
        reason: "timeout",
      },
    ]);
  });

  it("lets cancellation win a race with a late checkpoint response", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({ publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-race");
    let resolvePreview!: (value: { canRewind: true; filesChanged: string[] }) => void;
    const preview = new Promise<{ canRewind: true; filesChanged: string[] }>((resolve) => {
      resolvePreview = resolve;
    });
    const reporting = support.report(turn, { rewindFiles: vi.fn(() => preview) });

    support.finish(turn.fileChangeReport, "cancelled");
    resolvePreview({ canRewind: true, filesChanged: ["src/late.ts"] });
    await reporting;

    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-race",
        status: "unavailable",
        reason: "cancelled",
      },
    ]);
  });

  it("caps path count and serialized report bytes", async () => {
    const cwd = path.join(os.tmpdir(), "native-file-report-caps");
    const reports: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      cwd,
      publish: async (result) => void reports.push(result),
    });
    const turn = requestedTurn(support, "request-caps");

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({
        canRewind: true,
        filesChanged: Array.from(
          { length: 1030 },
          (_, index) => `generated/${index}-${"x".repeat(280)}.txt`,
        ),
      })),
    });

    expect(reports[0]).toMatchObject({
      status: "reported",
      declaredComplete: false,
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(reports[0]), "utf8")).toBeLessThanOrEqual(
      AGENT_FILE_CHANGE_REPORT_MAX_BYTES,
    );
  });

  it("fails open when report publication fails", async () => {
    const logError = vi.fn();
    const support = createSupport({
      publish: async () => {
        throw new Error("transport closed");
      },
      logError,
    });
    const turn = requestedTurn(support, "request-publish-failure");

    await expect(
      support.report(turn, {
        rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged: [] })),
      }),
    ).resolves.toBeUndefined();

    expect(turn.fileChangeReport?.phase).toBe("finished");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("transport closed"));
  });

  /** Subagent-edited paths are unioned with the checkpoint paths and deduped. */
  it("adds subagent edited paths to the checkpoint paths", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const cwd = process.cwd();
    const support = createSupport({ cwd, publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-union", [path.join(cwd, "GEMINI.md"), "src/a.ts"]);

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({
        canRewind: true,
        filesChanged: ["src/a.ts", "README.md"],
      })),
    });

    expect(published).toMatchObject([
      {
        status: "reported",
        paths: [
          path.join(cwd, "src/a.ts"),
          path.join(cwd, "README.md"),
          path.join(cwd, "GEMINI.md"),
        ],
        declaredComplete: false,
      },
    ]);
  });

  /** When the checkpoint cannot be previewed, the subagent edits are still reported. */
  it("reports subagent edited paths when the checkpoint cannot be previewed", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const cwd = process.cwd();
    const support = createSupport({ cwd, publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-fallback", ["GEMINI.md"]);

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({ canRewind: false, error: "checkpoint missing" })),
    });

    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-fallback",
        status: "reported",
        paths: [path.join(cwd, "GEMINI.md")],
        declaredComplete: false,
        truncated: false,
      },
    ]);
  });

  /** A checkpoint preview timeout falls back to the subagent edited paths. */
  it("reports subagent edited paths when the checkpoint preview times out", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const cwd = process.cwd();
    const support = createSupport({
      cwd,
      publish: async (result) => void published.push(result),
      timeoutMs: 1,
    });
    const turn = requestedTurn(support, "request-timeout-fallback", ["GEMINI.md"]);
    const never = new Promise<never>(() => {});

    await support.report(turn, { rewindFiles: vi.fn(() => never) });

    expect(published).toMatchObject([
      { status: "reported", paths: [path.join(cwd, "GEMINI.md")], declaredComplete: false },
    ]);
  });

  /** A thrown checkpoint error falls back to the subagent edited paths. */
  it("reports subagent edited paths when the checkpoint preview throws", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const cwd = process.cwd();
    const support = createSupport({ cwd, publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-throw-fallback", ["GEMINI.md"]);

    await support.report(turn, {
      rewindFiles: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    expect(published).toMatchObject([{ status: "reported", paths: [path.join(cwd, "GEMINI.md")] }]);
  });

  /** Without subagent edits an unusable checkpoint is still unavailable. */
  it("stays unavailable when there are no subagent edited paths", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({ publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-empty", []);

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({ canRewind: false, error: "checkpoint missing" })),
    });

    expect(published).toEqual([
      { version: 1, requestId: "request-empty", status: "unavailable", reason: "invalidOutput" },
    ]);
  });
});

describe("client-neutral agent file-change report", () => {
  const air = {
    jetbrains: { air: { version: 1, capabilities: ["agentFileChangeReport"] } },
  };
  const neutral = { agentFileChangeReport: { version: 1 } };

  it.each([
    ["no capability", {}, false, undefined],
    ["the opt-in", { _meta: neutral }, false, "neutral"],
    [
      "a later opt-in version",
      { _meta: { agentFileChangeReport: { version: 2 } } },
      false,
      "neutral",
    ],
    ["the AIR capability", { _meta: air }, false, "air"],
    ["both forms", { _meta: { ...air, ...neutral } }, false, "neutral"],
    ["the opt-in on ACP v2", { _meta: neutral }, true, undefined],
    ["both forms on ACP v2", { _meta: { ...air, ...neutral } }, true, "air"],
    ["the AIR capability on ACP v2", { _meta: air }, true, "air"],
  ])("selects the form for %s", (_label, capabilities, v2, form) => {
    expect(agentFileChangeReportForm(capabilities, v2)).toBe(form);
  });

  it.each([
    ["boolean", true],
    ["string", "1"],
    ["empty object", {}],
    ["string version", { version: "1" }],
    ["fractional version", { version: 1.5 }],
    ["zero version", { version: 0 }],
    ["negative version", { version: -1 }],
    ["null", null],
    ["array", [{ version: 1 }]],
  ])("does not opt in with %s", (_label, optIn) => {
    expect(agentFileChangeReportForm({ _meta: { agentFileChangeReport: optIn } })).toBeUndefined();
  });

  it("reads the request only at top level, with the validation of the AIR form", () => {
    const request = { version: 1, requestId: "turn:42_a-b.c" };

    expect(
      agentFileChangeReportRequestId({ agentFileChangeReportRequest: request }, "neutral"),
    ).toBe("turn:42_a-b.c");
    expect(
      agentFileChangeReportRequestId(
        { jetbrains: { air: { agentFileChangeReportRequest: request } } },
        "neutral",
      ),
    ).toBeUndefined();
    expect(
      agentFileChangeReportRequestId({ agentFileChangeReportRequest: request }, "air"),
    ).toBeUndefined();
    for (const malformed of MALFORMED_REQUESTS) {
      expect(
        agentFileChangeReportRequestId({ agentFileChangeReportRequest: malformed }, "neutral"),
      ).toBeUndefined();
    }
    for (const meta of [undefined, null, "request", []]) {
      expect(agentFileChangeReportRequestId(meta, "neutral")).toBeUndefined();
    }
  });

  it("puts the report at top level, and keeps the exact bytes of the AIR form", () => {
    const report: AgentFileChangeReportResult = {
      version: 1,
      requestId: "request",
      status: "unavailable",
      reason: "cancelled",
    };

    expect(agentFileChangeReportMeta(report, "neutral")).toEqual({
      agentFileChangeReport: report,
    });
    expect(JSON.stringify(agentFileChangeReportMeta(report, "air"))).toBe(
      '{"jetbrains":{"air":{"version":1,"agentFileChangeReport":{"version":1,"requestId":"request","status":"unavailable","reason":"cancelled"}}}}',
    );
  });

  it.each([
    ["checkpoint preview", { canRewind: true, filesChanged: ["src/a.ts"] }, "src/a.ts"],
    ["subagent fallback", { canRewind: false, error: "checkpoint missing" }, "GEMINI.md"],
  ])("adds the fixed uncertainty to a reported list from the %s", async (_label, preview, file) => {
    const cwd = process.cwd();
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      form: "neutral",
      cwd,
      publish: async (result) => void published.push(result),
    });
    const turn = requestedTurn(support, "request-1", ["GEMINI.md"], "neutral");

    await support.report(turn, { rewindFiles: vi.fn(async () => preview) });

    expect(published[0]).toMatchObject({
      status: "reported",
      paths: expect.arrayContaining([path.join(cwd, file)]),
      declaredComplete: false,
      uncertainty: NEUTRAL_AGENT_FILE_CHANGE_REPORT_UNCERTAINTY,
    });
  });

  it("gives an AIR report no uncertainty", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({ publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-1");

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged: ["src/a.ts"] })),
    });

    expect(published[0]).not.toHaveProperty("uncertainty");
  });

  it("gives an unavailable report no uncertainty", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      form: "neutral",
      publish: async (result) => void published.push(result),
    });

    support.finish(
      requestedTurn(support, "request-1", undefined, "neutral").fileChangeReport,
      "cancelled",
    );

    expect(published).toEqual([
      { version: 1, requestId: "request-1", status: "unavailable", reason: "cancelled" },
    ]);
  });

  /** A list that just fits the AIR form must lose paths to fit the neutral one. */
  it("counts the uncertainty in the wire limit", async () => {
    const cwd = path.join(os.tmpdir(), "native-file-report-neutral-caps");
    const preview = async (form: AgentFileChangeReportForm, filesChanged: string[]) => {
      const published: AgentFileChangeReportResult[] = [];
      const support = createSupport({
        form,
        cwd,
        publish: async (result) => void published.push(result),
      });
      await support.report(requestedTurn(support, "request-caps", undefined, form), {
        rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged })),
      });
      return published[0];
    };
    const size = (report: AgentFileChangeReportResult) =>
      Buffer.byteLength(JSON.stringify(report), "utf8");
    const files = Array.from({ length: 60 }, (_, index) => `g/${index}-${"x".repeat(3900)}.txt`);
    let spare = AGENT_FILE_CHANGE_REPORT_MAX_BYTES - size(await preview("air", files));
    while (spare > 3000) {
      files.push(`g/${files.length}-${"x".repeat(2000)}.txt`);
      spare = AGENT_FILE_CHANGE_REPORT_MAX_BYTES - size(await preview("air", files));
    }
    // One more path fills the limit: its JSON is `,"<parent>/<name>"`.
    const parent = path.join(fs.realpathSync.native(os.tmpdir()), path.basename(cwd));
    const name = "y".repeat(spare - Buffer.byteLength(parent, "utf8") - 4);
    const filling = [...files, name];

    const fits = await preview("air", filling);
    const fitted = await preview("neutral", filling);

    expect(size(fits)).toBe(AGENT_FILE_CHANGE_REPORT_MAX_BYTES);
    expect(fits).toMatchObject({ truncated: false, paths: { length: filling.length } });
    expect(size(fitted)).toBeLessThanOrEqual(AGENT_FILE_CHANGE_REPORT_MAX_BYTES);
    expect(fitted).toMatchObject({
      truncated: true,
      uncertainty: NEUTRAL_AGENT_FILE_CHANGE_REPORT_UNCERTAINTY,
    });
  });
});

describe("recordSubagentFileEdits", () => {
  const toolUses = {
    edit: { name: "Edit", input: { file_path: "/work/a.ts" } },
    write: { name: "Write", input: { file_path: "/work/b.ts" } },
    notebook: { name: "NotebookEdit", input: { notebook_path: "/work/n.ipynb" } },
    read: { name: "Read", input: { file_path: "/work/c.ts" } },
  };
  const results = (...ids: string[]) =>
    ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" }));
  const reportTurn = () => ({
    promptUuid: "prompt-uuid",
    fileChangeReport: { requestId: "request", phase: "requested" as const },
    settled: false,
    editedPaths: undefined as Set<string> | undefined,
  });

  /** Edit, Write and NotebookEdit results of a subagent add their paths; Read does not. */
  it("collects the paths of subagent file-tool edits", () => {
    const turn = reportTurn();
    recordSubagentFileEdits(
      turn,
      "toolu_agent",
      results("edit", "write", "notebook", "read"),
      toolUses,
    );
    expect([...(turn.editedPaths ?? [])]).toEqual(["/work/a.ts", "/work/b.ts", "/work/n.ipynb"]);
  });

  /** A failed subagent Edit changed no file, so its path is skipped. */
  it("skips error results", () => {
    const turn = reportTurn();
    recordSubagentFileEdits(
      turn,
      "toolu_agent",
      [{ type: "tool_result", tool_use_id: "edit", content: "failed", is_error: true }],
      toolUses,
    );
    expect(turn.editedPaths).toBeUndefined();
  });

  /** Root-agent edits are left to the checkpoint, so a root message adds nothing. */
  it("skips root-agent messages", () => {
    const turn = reportTurn();
    recordSubagentFileEdits(turn, null, results("edit"), toolUses);
    expect(turn.editedPaths).toBeUndefined();
  });

  /** A settled turn, or one without a requested report, collects nothing. */
  it("skips turns that are settled or have no report", () => {
    const settled = { ...reportTurn(), settled: true };
    recordSubagentFileEdits(settled, "toolu_agent", results("edit"), toolUses);
    expect(settled.editedPaths).toBeUndefined();

    const unrequested = { ...reportTurn(), fileChangeReport: undefined };
    recordSubagentFileEdits(unrequested, "toolu_agent", results("edit"), toolUses);
    expect(unrequested.editedPaths).toBeUndefined();
  });
});
