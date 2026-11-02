import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { messageIdForGrouping } from "../acp-agent.js";
import { clientOptsIntoNeutralForkPoint, forkSession } from "../fork-session.js";
import { encodeProjectPath } from "../session-index/project-dirs.js";

// Use the real SDK against temporary transcripts, without starting Claude Code.
let root: string;
let sourceCwd: string;
let destinationCwd: string;
let sessionId: string;
let sourceFile: string;
let transcript: string;
let activeUuid: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fork-session-")));
  sourceCwd = path.join(root, "source");
  destinationCwd = path.join(root, "destination");
  const configDir = path.join(root, "config");
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  await fs.mkdir(sourceCwd);
  await fs.mkdir(destinationCwd);
  sessionId = randomUUID();
  const userUuid = randomUUID();
  const firstUuid = randomUUID();
  const followupUuid = randomUUID();
  activeUuid = randomUUID();
  const common = { sessionId, cwd: sourceCwd, isSidechain: false };
  const entries = [
    {
      ...common,
      type: "user",
      uuid: userUuid,
      parentUuid: null,
      message: { role: "user", content: "First prompt" },
    },
    {
      ...common,
      type: "assistant",
      uuid: firstUuid,
      parentUuid: userUuid,
      message: {
        id: "msg_first",
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
      },
    },
    {
      ...common,
      type: "user",
      uuid: followupUuid,
      parentUuid: firstUuid,
      message: { role: "user", content: "Follow-up prompt" },
    },
    {
      ...common,
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: followupUuid,
      message: {
        id: "msg_inactive",
        role: "assistant",
        content: [{ type: "text", text: "Inactive answer" }],
      },
    },
    {
      ...common,
      type: "assistant",
      uuid: activeUuid,
      parentUuid: followupUuid,
      message: {
        id: "msg_active",
        role: "assistant",
        content: [{ type: "text", text: "Active answer" }],
      },
    },
  ];
  transcript =
    entries
      .map((entry, index) =>
        JSON.stringify({ ...entry, timestamp: new Date(1_700_000_000_000 + index).toISOString() }),
      )
      .join("\n") + "\n";
  const projectDir = path.join(configDir, "projects", encodeProjectPath(sourceCwd));
  await fs.mkdir(projectDir, { recursive: true });
  sourceFile = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(sourceFile, transcript);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const INACTIVE_FINGERPRINT = `sha256:${createHash("sha256").update("Inactive answer").digest("hex")}`;

/** The `_meta` of a fork at `point`, in the AIR or the client-neutral form. */
function forkMeta(form: "air" | "neutral", point: Record<string, unknown>) {
  return form === "air"
    ? { jetbrains: { air: { fork: { version: 1, ...point } } } }
    : { forkPoint: point };
}

describe.each([
  { directory: "same directory", form: "air" as const },
  { directory: "different directory", form: "air" as const },
  { directory: "same directory", form: "neutral" as const },
  { directory: "different directory", form: "neutral" as const },
])("fork into $directory with the $form fork point", ({ directory, form }) => {
  it.each([
    { resolution: "latest", messageId: undefined, expectedAnswer: "Active answer", count: 4 },
    {
      resolution: "active history",
      messageId: "msg_first",
      expectedAnswer: "First answer",
      count: 2,
      matchedId: "msg_first",
    },
    {
      resolution: "inactive branch",
      messageId: "msg_inactive",
      expectedAnswer: "Inactive answer",
      count: 4,
      matchedId: "msg_inactive",
    },
    {
      resolution: "segment suffix",
      messageId: "msg_first:segment:2",
      expectedAnswer: "First answer",
      count: 2,
      matchedId: "msg_first",
    },
    {
      resolution: "fingerprint",
      messageId: "stale-message-id",
      expectedAnswer: "Inactive answer",
      count: 4,
      matchedId: "msg_inactive",
    },
    {
      resolution: "live map",
      messageId: "msg_active",
      expectedAnswer: "Active answer",
      count: 4,
      matchedId: "msg_active",
    },
  ])("resolves the fork point through $resolution", async (scenario) => {
    const originalMessages = await getSessionMessages(sessionId);
    expect(originalMessages.map(messageIdForGrouping)).not.toContain("msg_inactive");
    const cwd = directory === "same directory" ? sourceCwd : destinationCwd;
    const result = await forkSession(
      {
        sessionId,
        cwd,
        mcpServers: [],
        ...(scenario.messageId && {
          _meta: forkMeta(form, {
            messageId: scenario.messageId,
            ...(scenario.resolution === "fingerprint" && {
              messageFingerprint: INACTIVE_FINGERPRINT,
              messageOccurrence: 1,
            }),
          }),
        }),
      },
      {
        messageIdForGrouping,
        neutralForkPoint: form === "neutral",
        ...(scenario.resolution === "live map" && {
          liveMessageIdToUuid: new Map([["msg_active", activeUuid]]),
        }),
      },
    );

    expect(result.sessionId).not.toBe(sessionId);
    // Only the neutral form reports where the fork ends.
    expect(result._meta).toEqual(
      form === "neutral" && scenario.matchedId
        ? {
            forkPoint: {
              boundary: "message",
              messageId: scenario.matchedId,
              matchedBy: scenario.resolution === "fingerprint" ? "fingerprint" : "id",
            },
          }
        : undefined,
    );
    const messages = await getSessionMessages(result.sessionId);
    expect(messages).toHaveLength(scenario.count);
    expect(messages.at(-1)?.message).toMatchObject({
      content: [{ type: "text", text: scenario.expectedAnswer }],
    });
    const originalUuids = originalMessages.map((message) => message.uuid);
    for (const message of messages) {
      expect(originalUuids).not.toContain(message.uuid);
    }
    expect(await fs.readFile(sourceFile, "utf8")).toBe(transcript);
  });

  it("rejects a fork point that is not in the source session", async () => {
    await expect(
      forkSession(
        {
          sessionId,
          cwd: directory === "same directory" ? sourceCwd : destinationCwd,
          mcpServers: [],
          _meta: forkMeta(form, { messageId: "missing" }),
        },
        { messageIdForGrouping, neutralForkPoint: form === "neutral" },
      ),
    ).rejects.toMatchObject({
      code: -32602,
      data:
        form === "neutral"
          ? { forkPoint: { messageId: "missing", reason: "notFound" } }
          : { messageId: "missing" },
      message: expect.stringContaining(
        `Fork point message missing was not found in session ${sessionId}`,
      ),
    });
    expect(await fs.readFile(sourceFile, "utf8")).toBe(transcript);
  });
});

describe("client-neutral fork point", () => {
  it.each([
    { capability: { version: 1 }, optsIn: true },
    { capability: { version: 2 }, optsIn: true },
    { capability: true, optsIn: false },
    { capability: { version: 0 }, optsIn: false },
    { capability: { version: 1.5 }, optsIn: false },
    { capability: { version: "1" }, optsIn: false },
    { capability: [{ version: 1 }], optsIn: false },
    { capability: undefined, optsIn: false },
  ])("opts in at initialize with $capability: $optsIn", ({ capability, optsIn }) => {
    expect(clientOptsIntoNeutralForkPoint({ _meta: { forkPoint: capability } })).toBe(optsIn);
  });

  it("resolves a fingerprint without an occurrence", async () => {
    const result = await forkSession(
      {
        sessionId,
        cwd: sourceCwd,
        mcpServers: [],
        _meta: { forkPoint: { messageId: "stale", messageFingerprint: INACTIVE_FINGERPRINT } },
      },
      { messageIdForGrouping, neutralForkPoint: true },
    );

    expect(result._meta).toEqual({
      forkPoint: { boundary: "message", messageId: "msg_inactive", matchedBy: "fingerprint" },
    });
    expect((await getSessionMessages(result.sessionId)).at(-1)?.message).toMatchObject({
      content: [{ type: "text", text: "Inactive answer" }],
    });
  });

  it.each([
    { invalid: "a non-object fork point", forkPoint: "msg_first", field: "forkPoint" },
    { invalid: "a null fork point", forkPoint: null, field: "forkPoint" },
    { invalid: "an array fork point", forkPoint: ["msg_first"], field: "forkPoint" },
    {
      invalid: "another version",
      forkPoint: { version: 2, messageId: "msg_first" },
      field: "version",
    },
    { invalid: "a missing message id", forkPoint: {}, field: "messageId" },
    { invalid: "a blank message id", forkPoint: { messageId: "  " }, field: "messageId" },
    { invalid: "a numeric message id", forkPoint: { messageId: 7 }, field: "messageId" },
    {
      invalid: "a fingerprint without the sha256 prefix",
      forkPoint: { messageId: "msg_first", messageFingerprint: INACTIVE_FINGERPRINT.slice(7) },
      field: "messageFingerprint",
    },
    {
      invalid: "an uppercase fingerprint",
      forkPoint: {
        messageId: "msg_first",
        messageFingerprint: `sha256:${INACTIVE_FINGERPRINT.slice(7).toUpperCase()}`,
      },
      field: "messageFingerprint",
    },
    {
      invalid: "a short fingerprint",
      forkPoint: { messageId: "msg_first", messageFingerprint: "sha256:abc" },
      field: "messageFingerprint",
    },
    {
      invalid: "a zero occurrence",
      forkPoint: { messageId: "msg_first", messageOccurrence: 0 },
      field: "messageOccurrence",
    },
    {
      invalid: "a fractional occurrence",
      forkPoint: { messageId: "msg_first", messageOccurrence: 1.5 },
      field: "messageOccurrence",
    },
    {
      invalid: "a string occurrence",
      forkPoint: { messageId: "msg_first", messageOccurrence: "1" },
      field: "messageOccurrence",
    },
  ])("rejects $invalid instead of forking the whole session", async ({ forkPoint, field }) => {
    await expect(
      forkSession(
        { sessionId, cwd: sourceCwd, mcpServers: [], _meta: { forkPoint } },
        { messageIdForGrouping, neutralForkPoint: true },
      ),
    ).rejects.toMatchObject({ code: -32602, data: { forkPoint: { field } } });
  });

  it("rejects a fork point from a client that did not opt in", async () => {
    await expect(
      forkSession(
        {
          sessionId,
          cwd: sourceCwd,
          mcpServers: [],
          _meta: { forkPoint: { messageId: "msg_first" } },
        },
        { messageIdForGrouping },
      ),
    ).rejects.toMatchObject({ code: -32602, data: { forkPoint: { field: "forkPoint" } } });
  });

  it("takes the neutral fork point over an AIR one in the same request", async () => {
    const result = await forkSession(
      {
        sessionId,
        cwd: sourceCwd,
        mcpServers: [],
        _meta: {
          ...forkMeta("air", { messageId: "msg_inactive" }),
          forkPoint: { messageId: "msg_first" },
        },
      },
      { messageIdForGrouping, neutralForkPoint: true },
    );

    expect(await getSessionMessages(result.sessionId)).toHaveLength(2);
  });
});
