import {
  ForkSessionRequest,
  ForkSessionResponse,
  RequestError,
} from "@agentclientprotocol/sdk/unstable";
import {
  forkSession as forkClaudeSession,
  getSessionMessages,
  importSessionToStore,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { assistantMessageText } from "./session-failure-extension.js";
import { SessionTiming } from "./session-timing.js";

type ForkSessionMeta = {
  [key: string]: unknown;
  jetbrains?: {
    air?: {
      fork?: {
        version?: number;
        messageId?: string;
        messageFingerprint?: string;
        messageOccurrence?: number;
      };
    };
  };
};

type ForkSessionDependencies = {
  liveMessageIdToUuid?: ReadonlyMap<string, string>;
  /** Whether the client opted into the client-neutral fork point at initialize
   *  (see {@link clientOptsIntoNeutralForkPoint}). */
  neutralForkPoint?: boolean;
  logger?: { log: (...args: unknown[]) => void };
  messageIdForGrouping: (message: {
    type?: string;
    uuid?: string | null;
    message?: unknown;
  }) => string | undefined;
};

type ForkPoint = {
  messageId: string;
  messageFingerprint?: string;
  messageOccurrence?: number;
  /** Whether the point came from the client-neutral `_meta.forkPoint`. */
  neutral: boolean;
};

/** The top-level `_meta` key of the client-neutral fork point. */
export const NEUTRAL_FORK_POINT_KEY = "forkPoint";
const NEUTRAL_FORK_POINT_VERSION = 1;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Whether `initialize.clientCapabilities._meta.forkPoint` is an object whose
 *  `version` is an integer of at least 1. */
export function clientOptsIntoNeutralForkPoint(capabilities: unknown): boolean {
  const optIn = recordOrUndefined(asRecord(asRecord(capabilities)._meta)[NEUTRAL_FORK_POINT_KEY]);
  const version = optIn?.version;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= NEUTRAL_FORK_POINT_VERSION
  );
}

/** The agent side of the client-neutral fork point, for the initialize `_meta`. */
export function neutralForkPointCapability(): { version: number; boundary: "message" } {
  return { version: NEUTRAL_FORK_POINT_VERSION, boundary: "message" };
}

function invalidForkPointField(field: string, message: string): RequestError {
  return RequestError.invalidParams({ [NEUTRAL_FORK_POINT_KEY]: { field } }, message);
}

/**
 * The fork point of a `session/fork` request with `_meta.forkPoint`. Unlike
 * the AIR form, a request that names a fork point never falls back to a fork
 * of the whole session: every malformed field is an invalid params error.
 */
function neutralForkPoint(value: unknown, optedIn: boolean): ForkPoint {
  if (!optedIn) {
    throw invalidForkPointField(
      NEUTRAL_FORK_POINT_KEY,
      "_meta.forkPoint needs clientCapabilities._meta.forkPoint at initialize",
    );
  }
  const fork = recordOrUndefined(value);
  if (!fork) {
    throw invalidForkPointField(NEUTRAL_FORK_POINT_KEY, "_meta.forkPoint must be an object");
  }
  if (fork.version !== undefined && fork.version !== NEUTRAL_FORK_POINT_VERSION) {
    throw invalidForkPointField("version", "_meta.forkPoint.version must be 1 when present");
  }
  const messageId = typeof fork.messageId === "string" ? fork.messageId.trim() : "";
  if (!messageId) {
    throw invalidForkPointField(
      "messageId",
      "_meta.forkPoint.messageId must be a non-blank string",
    );
  }
  const messageFingerprint = fork.messageFingerprint;
  if (
    messageFingerprint !== undefined &&
    (typeof messageFingerprint !== "string" || !FINGERPRINT_PATTERN.test(messageFingerprint))
  ) {
    throw invalidForkPointField(
      "messageFingerprint",
      "_meta.forkPoint.messageFingerprint must be sha256: and 64 lowercase hex digits",
    );
  }
  const messageOccurrence = fork.messageOccurrence;
  if (
    messageOccurrence !== undefined &&
    !(
      typeof messageOccurrence === "number" &&
      Number.isSafeInteger(messageOccurrence) &&
      messageOccurrence > 0
    )
  ) {
    throw invalidForkPointField(
      "messageOccurrence",
      "_meta.forkPoint.messageOccurrence must be a positive integer",
    );
  }
  return {
    messageId,
    neutral: true,
    ...(messageFingerprint !== undefined
      ? {
          messageFingerprint,
          // Without an occurrence, the fingerprint names its first equal message on the branch.
          messageOccurrence: (messageOccurrence as number | undefined) ?? 1,
        }
      : {}),
  };
}

function forkPoint(meta: unknown, optedIntoNeutral: boolean): ForkPoint | undefined {
  const record = recordOrUndefined(meta);
  // A request with `_meta.forkPoint` takes the neutral path, whatever else it carries.
  if (record && record[NEUTRAL_FORK_POINT_KEY] !== undefined) {
    return neutralForkPoint(record[NEUTRAL_FORK_POINT_KEY], optedIntoNeutral);
  }
  return airForkPoint(meta);
}

function airForkPoint(meta: unknown): ForkPoint | undefined {
  const fork = (meta as ForkSessionMeta | null | undefined)?.jetbrains?.air?.fork;
  if (fork?.version !== 1) return undefined;
  const messageId = fork.messageId?.trim();
  if (!messageId) return undefined;
  const messageFingerprint = fork.messageFingerprint?.trim();
  const messageOccurrence = fork.messageOccurrence;
  return {
    messageId,
    neutral: false,
    ...(messageFingerprint ? { messageFingerprint } : {}),
    // AIR computes this with count(...) over the visible prefix, so it is 1-based.
    ...(typeof messageOccurrence === "number" &&
    Number.isSafeInteger(messageOccurrence) &&
    messageOccurrence > 0
      ? { messageOccurrence }
      : {}),
  };
}

function forkPointMessageIdCandidates(messageId: string): string[] {
  // Older AIR builds sent their visible segment id. Prefer the exact id before its ACP source id.
  const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
  return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

async function loadFullSessionHistory(sessionId: string): Promise<SessionStoreEntry[]> {
  // getSessionMessages returns only the active parentUuid chain. The import keeps inactive branches that AIR can still reference.
  const entries: SessionStoreEntry[] = [];
  const store: SessionStore = {
    append: async (_key, batch) => {
      entries.push(...batch);
    },
    load: async () => null,
  };
  await importSessionToStore(sessionId, store, { includeSubagents: false });
  return entries;
}

function assistantGroups(
  entries: SessionStoreEntry[],
  messageIdForGrouping: ForkSessionDependencies["messageIdForGrouping"],
) {
  const groups = new Map<string, { uuid?: string; text: string }>();
  for (const entry of entries) {
    if (
      entry.type !== "assistant" ||
      entry.isSidechain === true ||
      entry.parent_tool_use_id != null ||
      entry.parent_agent_id != null
    ) {
      continue;
    }
    const messageId = messageIdForGrouping(entry);
    if (!messageId) continue;
    const group = groups.get(messageId) ?? { text: "" };
    if (typeof entry.uuid === "string" && entry.uuid.length > 0) group.uuid = entry.uuid;
    group.text += assistantMessageText(entry.message) ?? "";
    groups.set(messageId, group);
  }
  return groups;
}

function fingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function fingerprintOccurrenceOnBranch(
  targetUuid: string,
  expectedFingerprint: string,
  entries: SessionStoreEntry[],
  groups: ReturnType<typeof assistantGroups>,
  messageIdForGrouping: ForkSessionDependencies["messageIdForGrouping"],
): number {
  const entriesByUuid = new Map(
    entries.flatMap((entry) => (typeof entry.uuid === "string" ? [[entry.uuid, entry]] : [])),
  );
  const seenGroups = new Set<string>();
  let occurrence = 0;
  let cursor: string | undefined = targetUuid;
  while (cursor) {
    const entry = entriesByUuid.get(cursor);
    if (!entry) break;
    if (
      entry.type === "assistant" &&
      entry.isSidechain !== true &&
      entry.parent_tool_use_id == null &&
      entry.parent_agent_id == null
    ) {
      const messageId = messageIdForGrouping(entry);
      if (messageId && !seenGroups.has(messageId)) {
        seenGroups.add(messageId);
        const group = groups.get(messageId);
        if (group && fingerprint(group.text) === expectedFingerprint) occurrence++;
      }
    }
    cursor = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
  }
  return occurrence;
}

/** The message a fork point resolved to: its first entry uuid, its ACP
 *  message id, and whether the id or the fingerprint found it. */
type ForkPointMatch = { uuid: string; messageId: string; matchedBy: "id" | "fingerprint" };

function resolveFromFullHistory(
  entries: SessionStoreEntry[],
  candidates: string[],
  point: ForkPoint,
  messageIdForGrouping: ForkSessionDependencies["messageIdForGrouping"],
): ForkPointMatch | undefined {
  const groups = assistantGroups(entries, messageIdForGrouping);
  for (const candidate of candidates) {
    const uuid = groups.get(candidate)?.uuid;
    if (uuid) return { uuid, messageId: candidate, matchedBy: "id" };
  }
  if (!point.messageFingerprint || !point.messageOccurrence) return undefined;

  const fingerprintMatches = [...groups.entries()]
    .filter(([, group]) => group.uuid && fingerprint(group.text) === point.messageFingerprint)
    .map(([messageId, group]) => ({
      uuid: group.uuid!,
      messageId,
      matchedBy: "fingerprint" as const,
    }));
  // If only one persisted message has this content, the fingerprint already
  // identifies it even when an older client supplied an incompatible index.
  if (fingerprintMatches.length === 1) return fingerprintMatches[0];

  const occurrenceMatches = fingerprintMatches.filter(
    (group) =>
      fingerprintOccurrenceOnBranch(
        group.uuid,
        point.messageFingerprint!,
        entries,
        groups,
        messageIdForGrouping,
      ) === point.messageOccurrence,
  );
  return occurrenceMatches.length === 1 ? occurrenceMatches[0] : undefined;
}

/**
 * Whether `error` is the Claude SDK's report that `sessionId` has no
 * transcript: `forkSession` and `importSessionToStore` throw
 * `Error("Session <id> not found")`, and both throw
 * `"Invalid sessionId: <id>"` for an id that is not a UUID.
 */
function isUnknownSessionError(error: unknown, sessionId: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === `Session ${sessionId} not found` ||
    error.message === `Invalid sessionId: ${sessionId}`
  );
}

export async function forkSession(
  params: ForkSessionRequest,
  dependencies: ForkSessionDependencies,
): Promise<ForkSessionResponse> {
  try {
    return await forkTranscript(params, dependencies);
  } catch (error) {
    if (isUnknownSessionError(error, params.sessionId)) {
      throw RequestError.sessionNotFound(params.sessionId);
    }
    throw error;
  }
}

async function forkTranscript(
  params: ForkSessionRequest,
  dependencies: ForkSessionDependencies,
): Promise<ForkSessionResponse> {
  const timing = new SessionTiming(dependencies.logger, "fork", params.sessionId);
  const point = forkPoint(params._meta, dependencies.neutralForkPoint === true);
  // SDK `dir` scopes source lookup, not the fork's working directory. Search
  // all projects: params.cwd can name a different workspace for the new session.
  if (!point) {
    const forked = await forkClaudeSession(params.sessionId);
    timing.phase("sdk-fork", " resolution=latest");
    return { sessionId: forked.sessionId };
  }

  const candidateIds = forkPointMessageIdCandidates(point.messageId);
  const liveMatch = matchCandidate(candidateIds, (candidateId) =>
    dependencies.liveMessageIdToUuid?.get(candidateId),
  );
  const history = liveMatch ? undefined : await getSessionMessages(params.sessionId);
  timing.phase("active-history", ` resolution=${liveMatch ? "live" : "pending"}`);
  const activeMatch =
    liveMatch ??
    matchCandidate(
      candidateIds,
      (candidateId) =>
        history
          ?.slice()
          .reverse()
          .find((message) => dependencies.messageIdForGrouping(message) === candidateId)?.uuid,
    );
  const fullHistoryMatch = activeMatch
    ? undefined
    : resolveFromFullHistory(
        await loadFullSessionHistory(params.sessionId),
        candidateIds,
        point,
        dependencies.messageIdForGrouping,
      );
  timing.phase(
    "full-history",
    ` resolution=${liveMatch ? "live" : activeMatch ? "active" : fullHistoryMatch ? "full" : "missing"}`,
  );

  const match = activeMatch ?? fullHistoryMatch;
  if (!match) {
    throw RequestError.invalidParams(
      point.neutral
        ? { [NEUTRAL_FORK_POINT_KEY]: { messageId: point.messageId, reason: "notFound" } }
        : { messageId: point.messageId },
      `Fork point message ${point.messageId} was not found in session ${params.sessionId}`,
    );
  }

  const forked = await forkClaudeSession(params.sessionId, { upToMessageId: match.uuid });
  timing.phase("sdk-fork");
  return {
    sessionId: forked.sessionId,
    ...(point.neutral
      ? {
          _meta: {
            [NEUTRAL_FORK_POINT_KEY]: {
              boundary: "message",
              messageId: match.messageId,
              matchedBy: match.matchedBy,
            },
          },
        }
      : {}),
  };
}

/** The first candidate id that `uuidOf` finds, as an id match. */
function matchCandidate(
  candidateIds: string[],
  uuidOf: (candidateId: string) => string | undefined,
): ForkPointMatch | undefined {
  for (const candidateId of candidateIds) {
    const uuid = uuidOf(candidateId);
    if (uuid) return { uuid, messageId: candidateId, matchedBy: "id" };
  }
  return undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return recordOrUndefined(value) ?? {};
}
