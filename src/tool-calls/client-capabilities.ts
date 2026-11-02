import type { ClientCapabilities as AcpClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import {
  AIR_DIFF_PATCH_CAPABILITY,
  AIR_PLAN_FILE_CAPABILITY,
  AIR_RAW_INPUT_RENDERING_CAPABILITY,
  clientSupportsAirCapability,
  isAirClient,
} from "../air-extension.js";
import type { PatchForm } from "../diff.js";

/**
 * The client choices that decide the shape of a tool call report.
 *
 * The agent reads them once from `initialize.clientCapabilities`. The public
 * `toAcpNotifications` functions take the ACP capabilities and read them on
 * each call. The {@link AcpToolCallRenderer} reads nothing else, so one object
 * holds every capability choice of a tool call report.
 */
export class ClientCapabilities {
  constructor(
    /** The client renders a terminal from `_meta.terminal_info`, `terminal_output`, and `terminal_exit`. */
    readonly terminalOutput: boolean = false,
    /** The client appends `_meta.terminal_output_delta` instead of `terminal_output` chunks. */
    readonly terminalOutputDelta: boolean = false,
    /**
     * The client accepts an exact git patch in a diff: AIR's `jetbrains.air`
     * `diffPatch`, or the client-neutral `diffPatch` (see {@link neutralDiffPatch}).
     */
    readonly diffPatch: boolean = false,
    /** The capabilities that only JetBrains AIR declares. */
    readonly air: AirCapabilities = NO_AIR,
    /**
     * The client speaks ACP v2. Its diffs carry structured `changes` and an
     * optional git patch, which a v1 diff cannot express. Only the v2 surface
     * sets this, never the capabilities that a client sends. A v2 client also
     * takes the terminal extension (`terminalOutput`), which the v2 surface
     * sends as display terminals.
     */
    readonly v2: boolean = false,
    /**
     * The client opted into the client-neutral diff patch
     * (`clientCapabilities._meta.diffPatch`). Its diffs carry the patch at
     * top-level `_meta.diffPatch`, also when it declares AIR's `diffPatch` too,
     * and its `rawInput` leaves out the file text that a diff holds. Only ACP
     * v1 reads the opt-in.
     */
    readonly neutralDiffPatch: boolean = false,
  ) {}

  /** The form of a diff that carries an exact patch, for a client with {@link diffPatch} or {@link v2}. */
  get patchForm(): PatchForm {
    return this.v2 ? "v2" : this.neutralDiffPatch ? "neutral" : "air";
  }

  static from(
    capabilities: AcpClientCapabilities | null | undefined,
    { v2 = false }: { v2?: boolean } = {},
  ): ClientCapabilities {
    const meta = capabilities?._meta;
    const terminalOutputDelta = meta?.["terminal_output_delta"] === true;
    // ACP v2 has its own patch form and ignores the neutral opt-in.
    const neutralDiffPatch = !v2 && clientOptsIntoNeutralDiffPatch(capabilities);
    return new ClientCapabilities(
      v2 || terminalOutputDelta || meta?.["terminal_output"] === true,
      terminalOutputDelta,
      neutralDiffPatch || clientSupportsAirCapability(capabilities, AIR_DIFF_PATCH_CAPABILITY),
      {
        client: isAirClient(capabilities),
        rawInputRendering: clientSupportsAirCapability(
          capabilities,
          AIR_RAW_INPUT_RENDERING_CAPABILITY,
        ),
        planFile: clientSupportsAirCapability(capabilities, AIR_PLAN_FILE_CAPABILITY),
      },
      v2,
      neutralDiffPatch,
    );
  }
}

/** The top-level `_meta` key of the client-neutral diff patch. */
export const NEUTRAL_DIFF_PATCH_KEY = "diffPatch";
const NEUTRAL_DIFF_PATCH_VERSION = 1;

/** Whether `initialize.clientCapabilities._meta.diffPatch` is an object whose
 *  `version` is an integer of at least 1. */
export function clientOptsIntoNeutralDiffPatch(capabilities: unknown): boolean {
  const meta = recordOrUndefined(recordOrUndefined(capabilities)?._meta);
  const version = recordOrUndefined(meta?.[NEUTRAL_DIFF_PATCH_KEY])?.version;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= NEUTRAL_DIFF_PATCH_VERSION
  );
}

/** The agent side of the client-neutral diff patch, for the initialize `_meta`. */
export function neutralDiffPatchCapability(): { version: number; format: "git_patch" } {
  return { version: NEUTRAL_DIFF_PATCH_VERSION, format: "git_patch" };
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The capabilities of JetBrains AIR, read from `_meta.jetbrains.air`. */
export interface AirCapabilities {
  /**
   * The client declared `_meta.jetbrains.air`. Only then does a report follow
   * the tool call contract of `docs/air-extensions.md`. Every other client
   * gets the fields of the upstream adapter, and only the unchanged fields of
   * an update are left out.
   */
  readonly client: boolean;
  /**
   * AIR renders `rawInput` itself. A tool call report for AIR then carries no
   * display copy of the input in `content`.
   */
  readonly rawInputRendering: boolean;
  /**
   * AIR reads the plan of an ExitPlanMode from the file that
   * `rawInput.planFilePath` names. A report then carries the path and not the
   * plan text, when the plan file exists.
   */
  readonly planFile: boolean;
}

const NO_AIR: AirCapabilities = {
  client: false,
  rawInputRendering: false,
  planFile: false,
};
