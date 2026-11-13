/**
 * The `available_commands_update` list: the slash commands Claude Code reports,
 * minus the ones ACP clients can't run, plus the commands the adapter adds.
 */
import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable";
import type { Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { AIR_KIND_KEY, AIR_SKILL_PATH_KEY, withAirMeta } from "./air-extension.js";
import { MCP_AVAILABLE_COMMAND } from "./mcp-command.js";
import {
  claudeCodeOffersCommand,
  REMOTE_CONTROL_COMMAND_NAME,
  supportsRemoteControl,
} from "./remote-control.js";
import { NEUTRAL_COMMAND_PRESENTATION_KEY } from "./tool-calls/client-capabilities.js";
import { resolveSkillPath, type SkillScanCache } from "./tool-calls/reporters/interaction.js";

/** The forms in which a skill command carries its kind and `SKILL.md` path. */
export type SkillRecords = { air: boolean; neutral: boolean };

/** The `_meta` of a skill command, with the `SKILL.md` path when the skill has a file. */
function skillMeta(
  records: SkillRecords,
  skillMdPath: string | undefined,
): Record<string, unknown> {
  const airKind = records.air ? withAirMeta(undefined, AIR_KIND_KEY, "skill") : {};
  const air =
    records.air && skillMdPath ? withAirMeta(airKind, AIR_SKILL_PATH_KEY, skillMdPath) : airKind;
  return {
    ...air,
    ...(records.neutral
      ? {
          [NEUTRAL_COMMAND_PRESENTATION_KEY]: {
            version: 1,
            kind: "skill",
            ...(skillMdPath ? { skillPath: skillMdPath } : {}),
          },
        }
      : {}),
  };
}

export function getAvailableSlashCommands(
  commands: SlashCommand[],
  // Names the CLI tagged terminal-bound on `system`/init (their UX lives in
  // the CLI's own terminal, which ACP clients aren't) — filtered alongside
  // the static list. Raw CLI names, matched before the MCP rename.
  terminalCommands?: readonly string[],
  // The session cwd of a client that gets the kind and the SKILL.md path of
  // each skill command (AIR or a neutral commandPresentation client), or
  // undefined for every other client.
  airSkillCwd?: string,
  // The resolved SKILL.md paths of the session, keyed by the cwd and the name.
  skillPaths?: Map<string, string | undefined>,
  query?: Query,
  // The skill files Claude Code reports (`getContextUsage().skills.skillFrontmatter`).
  // A listed skill gets its path from here; one that is not listed, or has no
  // path (remote connections), is looked up on disk.
  skillFiles?: ReadonlyMap<string, { path?: string }>,
  // The forms of the skill record: AIR's `_meta.jetbrains.air` and the neutral `_meta.commandPresentation`.
  skillRecords: SkillRecords = { air: true, neutral: false },
): AvailableCommand[] {
  // The container listings of this one pass, so a list of a hundred commands lists each container once.
  const skillScans: SkillScanCache = new Map();
  const skillPath = (name: string, cwd: string): string | undefined => {
    const key = `${cwd}\0${name}`;
    if (skillPaths?.has(key)) return skillPaths.get(key);
    const resolved = resolveSkillPath(name, cwd, skillScans);
    skillPaths?.set(key, resolved);
    return resolved;
  };

  const UNSUPPORTED_COMMANDS = [
    "clear",
    "cost",
    "keybindings-help",
    "login",
    "logout",
    "output-style:new",
    "release-notes",
    "todos",
  ];

  const remoteControlCommands: AvailableCommand[] =
    query && supportsRemoteControl(query)
      ? [
          {
            name: REMOTE_CONTROL_COMMAND_NAME,
            description:
              "Continue this session from claude.ai/code or the Claude mobile app; `off` disconnects",
            input: { hint: "[session name | off]" },
          },
        ]
      : [];

  // The adapter replaces the terminal text of `/mcp` and runs its actions,
  // even when Claude Code tags the command terminal-bound.
  const advertised = commands
    .filter((command) => command.name !== "mcp" && !terminalCommands?.includes(command.name))
    .map((command) => {
      const input = command.argumentHint
        ? {
            hint: Array.isArray(command.argumentHint)
              ? command.argumentHint.join(" ")
              : command.argumentHint,
          }
        : null;
      let name = command.name;
      const mcpPrompt = command.name.endsWith(" (MCP)");
      if (mcpPrompt) {
        name = `mcp:${name.replace(" (MCP)", "")}`;
      }
      const skillFile = airSkillCwd && !mcpPrompt ? skillFiles?.get(command.name) : undefined;
      const skillMdPath =
        skillFile?.path ??
        (airSkillCwd && !command.builtin && !mcpPrompt
          ? skillPath(command.name, airSkillCwd)
          : undefined);
      return {
        name,
        description: command.description || "",
        input,
        // A skill without a file (bundled with the CLI, like `simplify`, or a remote connection): kind only.
        ...(skillMdPath || skillFile ? { _meta: skillMeta(skillRecords, skillMdPath) } : {}),
      };
    })
    .filter((command: AvailableCommand) => !UNSUPPORTED_COMMANDS.includes(command.name));

  // Command names must not contain whitespace and must be unique. A name
  // like "my command" is dropped, and of two commands named "review" only the
  // first is kept.
  const names = new Set<string>();
  return [
    ...advertised,
    MCP_AVAILABLE_COMMAND,
    ...remoteControlCommands.filter(
      (command) => !claudeCodeOffersCommand(commands, terminalCommands, command.name),
    ),
  ].filter((command) => {
    if (/\s/.test(command.name) || names.has(command.name)) return false;
    names.add(command.name);
    return true;
  });
}
