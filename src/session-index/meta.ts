/**
 * Where the session index reads and writes its metadata for one client.
 * An AIR client uses `_meta.jetbrains.air`; a client that opted into the
 * client-neutral session index uses top-level `_meta.sessionIndex`, with the
 * same payloads (docs/air-extensions.md, "Client-neutral session index").
 */

import { airExtensionMeta, withAirMeta } from "../air-extension.js";

/** The top-level `_meta` key of the client-neutral session index. */
export const NEUTRAL_SESSION_INDEX_KEY = "sessionIndex";
const NEUTRAL_SESSION_INDEX_VERSION = 1;

export type SessionIndexMeta = {
  /** The path of the namespace, for error messages. */
  readonly path: string;
  /** The session index object in a request `_meta`, if any. */
  read(meta: unknown): Record<string, unknown> | undefined;
  /** `meta` with one more field in the namespace. */
  with(
    meta: Record<string, unknown> | undefined,
    key: string,
    value: unknown,
  ): Record<string, unknown>;
};

export const AIR_SESSION_INDEX_META: SessionIndexMeta = {
  path: "_meta.jetbrains.air",
  read: airExtensionMeta,
  with: withAirMeta,
};

/** No `version` in rows and updates: as with the neutral `goal`, the version
 *  is negotiated once at initialize. */
export const NEUTRAL_SESSION_INDEX_META: SessionIndexMeta = {
  path: `_meta.${NEUTRAL_SESSION_INDEX_KEY}`,
  read: (meta) => recordOrUndefined(asRecord(meta)[NEUTRAL_SESSION_INDEX_KEY]),
  with: (meta, key, value) => ({
    ...meta,
    [NEUTRAL_SESSION_INDEX_KEY]: { ...asRecord(meta?.[NEUTRAL_SESSION_INDEX_KEY]), [key]: value },
  }),
};

/** Whether `initialize.clientCapabilities._meta.sessionIndex` is an object
 *  whose `version` is an integer of at least 1. Whether the client is AIR is
 *  for the caller to check: AIR clients use only the AIR capability. */
export function clientOptsIntoNeutralSessionIndex(capabilities: unknown): boolean {
  const optIn = recordOrUndefined(
    asRecord(asRecord(capabilities)._meta)[NEUTRAL_SESSION_INDEX_KEY],
  );
  const version = optIn?.version;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= NEUTRAL_SESSION_INDEX_VERSION
  );
}

/** `meta` with the agent side of the neutral session index. */
export function withNeutralSessionIndexCapabilities(
  meta: Record<string, unknown> | undefined,
  capabilities: string[],
): Record<string, unknown> {
  return {
    ...meta,
    [NEUTRAL_SESSION_INDEX_KEY]: { version: NEUTRAL_SESSION_INDEX_VERSION, capabilities },
  };
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return recordOrUndefined(value) ?? {};
}
