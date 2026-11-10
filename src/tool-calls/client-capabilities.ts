import type { ClientCapabilities as AcpClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import {
  AIR_DIFF_PATCH_CAPABILITY,
  AIR_PLAN_FILE_CAPABILITY,
  AIR_RAW_INPUT_RENDERING_CAPABILITY,
  clientSupportsAirCapability,
  isAirClient,
} from "../air-extension.js";
import type { PatchForm } from "../diff.js";
import { PROMPT_SUGGESTIONS_META_KEY } from "../prompt-suggestions.js";

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
    /**
     * The client opted into the client-neutral plan file
     * (`clientCapabilities._meta.planFile`). An ExitPlanMode report carries
     * `_meta.planFile` with the plan ID, the plan file, and the digest of the
     * plan, next to the plan text that every client that is not AIR gets. The
     * approved plan then has the ID of its review. A client that declares
     * AIR's `planFile` too gets the neutral form only. Only ACP v1 reads the
     * opt-in.
     */
    readonly neutralPlanFile: boolean = false,
    /**
     * The client opted into the client-neutral permission presentation
     * (`clientCapabilities._meta.permissionPresentation`). A permission request
     * carries the record of the AIR form at top-level
     * `_meta.permissionPresentation`. Only ACP v1 reads the opt-in.
     */
    readonly neutralPermissionPresentation: boolean = false,
    /**
     * The client opted into the client-neutral question custom answer
     * (`clientCapabilities._meta.questionCustomAnswer`). The companion text
     * field of an AskUserQuestion question carries
     * `_meta.questionCustomAnswer`. Only ACP v1 reads the opt-in.
     */
    readonly neutralQuestionCustomAnswer: boolean = false,
    /**
     * The client opted into the client-neutral recommended config value
     * (`clientCapabilities._meta.recommendedConfigValue`). The model selector
     * carries `_meta.recommendedConfigValue`, and its rows and current value do
     * not change. Only ACP v1 reads the opt-in.
     */
    readonly neutralRecommendedConfigValue: boolean = false,
    /**
     * The client opted into the client-neutral command presentation
     * (`clientCapabilities._meta.commandPresentation`). A skill command carries
     * `_meta.commandPresentation` with its kind and `SKILL.md` path. Only ACP v1
     * reads the opt-in.
     */
    readonly neutralCommandPresentation: boolean = false,
    /**
     * The client opted into the client-neutral load replay end
     * (`clientCapabilities._meta.loadReplayEnd`). After the whole history
     * replay of a `session/load`, the agent sends one `session_info_update`
     * with `_meta.loadReplayEnd`. Only ACP v1 reads the opt-in.
     */
    readonly neutralLoadReplayEnd: boolean = false,
    /**
     * The client opted into the client-neutral predicted prompt
     * (`clientCapabilities._meta.promptSuggestions`). A `session/prompt` that
     * names `_meta.promptSuggestions.id` gets the prediction of its turn,
     * carrying that id. Only ACP v1 reads the opt-in.
     */
    readonly neutralPromptSuggestions: boolean = false,
  ) {}

  /** Whether the agent predicts follow-up prompts for this client, in any form. */
  get predictsPrompts(): boolean {
    return this.air.client || this.neutralPromptSuggestions;
  }

  /** Whether skill commands carry their kind and `SKILL.md` path, in any form. */
  get presentsSkills(): boolean {
    return this.air.client || this.neutralCommandPresentation;
  }

  /**
   * Whether the approved plan of an ExitPlanMode has the ID of its review,
   * `plan-mode:<tool-call ID>`: for AIR and a neutral planFile client.
   */
  get linksPlanToReview(): boolean {
    return this.air.client || this.neutralPlanFile;
  }

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
    // A client that declares both plan file forms gets the neutral one.
    const neutralPlanFile = !v2 && clientOptsIntoNeutralPlanFile(capabilities);
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
        planFile:
          !neutralPlanFile && clientSupportsAirCapability(capabilities, AIR_PLAN_FILE_CAPABILITY),
      },
      v2,
      neutralDiffPatch,
      neutralPlanFile,
      !v2 && clientOptsIntoNeutralVersion(capabilities, NEUTRAL_PERMISSION_PRESENTATION_KEY),
      !v2 && clientOptsIntoNeutralVersion(capabilities, NEUTRAL_QUESTION_CUSTOM_ANSWER_KEY),
      !v2 && clientOptsIntoNeutralVersion(capabilities, NEUTRAL_RECOMMENDED_CONFIG_VALUE_KEY),
      !v2 && clientOptsIntoNeutralVersion(capabilities, NEUTRAL_COMMAND_PRESENTATION_KEY),
      !v2 && clientOptsIntoNeutralVersion(capabilities, NEUTRAL_LOAD_REPLAY_END_KEY),
      !v2 && clientOptsIntoNeutralVersion(capabilities, PROMPT_SUGGESTIONS_META_KEY),
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

/** The top-level `_meta` key of the client-neutral plan file. */
export const NEUTRAL_PLAN_FILE_KEY = "planFile";
export const NEUTRAL_PLAN_FILE_VERSION = 1;

/** Whether `initialize.clientCapabilities._meta.planFile` is an object whose
 *  `version` is an integer of at least 1. */
export function clientOptsIntoNeutralPlanFile(capabilities: unknown): boolean {
  const meta = recordOrUndefined(recordOrUndefined(capabilities)?._meta);
  const version = recordOrUndefined(meta?.[NEUTRAL_PLAN_FILE_KEY])?.version;
  return (
    typeof version === "number" && Number.isInteger(version) && version >= NEUTRAL_PLAN_FILE_VERSION
  );
}

/** The agent side of the client-neutral plan file, for the initialize `_meta`. */
export function neutralPlanFileCapability(): { version: number } {
  return { version: NEUTRAL_PLAN_FILE_VERSION };
}

/** The top-level `_meta` key of the client-neutral session failure. */
export const NEUTRAL_SESSION_FAILURE_KEY = "sessionFailure";
export const NEUTRAL_SESSION_FAILURE_VERSION = 1;

/** Whether `initialize.clientCapabilities._meta.sessionFailure` is an object
 *  whose `version` is an integer of at least 1. */
export function clientOptsIntoNeutralSessionFailure(capabilities: unknown): boolean {
  const meta = recordOrUndefined(recordOrUndefined(capabilities)?._meta);
  const version = recordOrUndefined(meta?.[NEUTRAL_SESSION_FAILURE_KEY])?.version;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= NEUTRAL_SESSION_FAILURE_VERSION
  );
}

/** The agent side of the client-neutral session failure, for the initialize `_meta`. */
export function neutralSessionFailureCapability(): { version: number } {
  return { version: NEUTRAL_SESSION_FAILURE_VERSION };
}

/** The top-level `_meta` key of the client-neutral agent file-change report. */
export const NEUTRAL_AGENT_FILE_CHANGE_REPORT_KEY = "agentFileChangeReport";
export const NEUTRAL_AGENT_FILE_CHANGE_REPORT_VERSION = 1;

/** Whether `initialize.clientCapabilities._meta.agentFileChangeReport` is an
 *  object whose `version` is an integer of at least 1. */
export function clientOptsIntoNeutralAgentFileChangeReport(capabilities: unknown): boolean {
  const meta = recordOrUndefined(recordOrUndefined(capabilities)?._meta);
  const version = recordOrUndefined(meta?.[NEUTRAL_AGENT_FILE_CHANGE_REPORT_KEY])?.version;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= NEUTRAL_AGENT_FILE_CHANGE_REPORT_VERSION
  );
}

/** The agent side of the client-neutral agent file-change report, for the initialize `_meta`. */
export function neutralAgentFileChangeReportCapability(): { version: number } {
  return { version: NEUTRAL_AGENT_FILE_CHANGE_REPORT_VERSION };
}

/** The top-level `_meta` key of the client-neutral permission presentation. */
export const NEUTRAL_PERMISSION_PRESENTATION_KEY = "permissionPresentation";
/** The top-level `_meta` key of the client-neutral question custom answer. */
export const NEUTRAL_QUESTION_CUSTOM_ANSWER_KEY = "questionCustomAnswer";
/** The top-level `_meta` key of the client-neutral recommended config value. */
export const NEUTRAL_RECOMMENDED_CONFIG_VALUE_KEY = "recommendedConfigValue";
/** The top-level `_meta` key of the client-neutral command presentation. */
export const NEUTRAL_COMMAND_PRESENTATION_KEY = "commandPresentation";
/** The top-level `_meta` key of the client-neutral load replay end, on the
 *  client capabilities, the initialize response, the `session/load` request
 *  and the end update. */
export const NEUTRAL_LOAD_REPLAY_END_KEY = "loadReplayEnd";

/**
 * The id that a `session/load` request names in `_meta.loadReplayEnd.id`, for
 * the end update of its replay to echo. Undefined when the request names none
 * or a value that is not a non-empty string of at most 256 characters.
 */
export function loadReplayEndRequestId(meta: unknown): string | undefined {
  return requestId(meta, NEUTRAL_LOAD_REPLAY_END_KEY);
}

/**
 * The id that a `session/prompt` names in `_meta.promptSuggestions.id` to ask
 * for the prediction of its turn. Undefined when the request names none or a
 * value that is not a non-empty string of at most 256 characters.
 */
export function promptSuggestionsRequestId(meta: unknown): string | undefined {
  return requestId(meta, PROMPT_SUGGESTIONS_META_KEY);
}

function requestId(meta: unknown, key: string): string | undefined {
  const id = recordOrUndefined(recordOrUndefined(meta)?.[key])?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
}

/** The agent side of a client-neutral presentation contract, for the initialize `_meta`. */
export function neutralPresentationCapability(): { version: number } {
  return { version: 1 };
}

/** Whether `initialize.clientCapabilities._meta[key]` is an object whose
 *  `version` is an integer of at least 1. */
function clientOptsIntoNeutralVersion(capabilities: unknown, key: string): boolean {
  const meta = recordOrUndefined(recordOrUndefined(capabilities)?._meta);
  const version = recordOrUndefined(meta?.[key])?.version;
  return typeof version === "number" && Number.isInteger(version) && version >= 1;
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
