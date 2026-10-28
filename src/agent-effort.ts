import type { AgentEffortLevel, AgentProfileRuntimePolicy } from './types.js';

export const AGENT_EFFORT_LEVELS = [
  'inherit',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly AgentEffortLevel[];

export const SDK_AGENT_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type SdkAgentEffort = (typeof SDK_AGENT_EFFORT_LEVELS)[number];

const AGENT_EFFORT_LEVEL_SET = new Set<string>(AGENT_EFFORT_LEVELS);
const SDK_AGENT_EFFORT_LEVEL_SET = new Set<string>(SDK_AGENT_EFFORT_LEVELS);

export function normalizeAgentEffort(value: unknown): AgentEffortLevel {
  return typeof value === 'string' && AGENT_EFFORT_LEVEL_SET.has(value)
    ? (value as AgentEffortLevel)
    : 'inherit';
}

/**
 * Resolve an Agent-owned SDK effort override. Undefined deliberately means
 * "inherit": keep the selected Provider's CLAUDE_CODE_EFFORT_LEVEL, or let the
 * SDK choose its model-aware default when the Provider does not define one.
 */
export function resolveAgentSdkEffort(
  policy: AgentProfileRuntimePolicy | undefined,
): SdkAgentEffort | undefined {
  const effort = policy?.reasoning?.effort;
  return typeof effort === 'string' && SDK_AGENT_EFFORT_LEVEL_SET.has(effort)
    ? (effort as SdkAgentEffort)
    : undefined;
}

/**
 * The effort lines of a launch's environment: an Agent's explicit effort
 * replaces the Provider's (the runner passes it as the SDK `effort` option),
 * and a conversation's own pick replaces both. Claude Code ranks
 * CLAUDE_CODE_EFFORT_LEVEL above that option, so the conversation's goes in
 * the environment and the Agent profile is never rewritten for it.
 */
export function applyLaunchEffortEnv(
  lines: string[],
  agentEffort: SdkAgentEffort | undefined,
  conversationEffort: string | undefined,
): void {
  if (!conversationEffort) {
    removeProviderEffortEnv(lines, agentEffort);
    return;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.startsWith('CLAUDE_CODE_EFFORT_LEVEL=')) {
      lines.splice(index, 1);
    }
  }
  lines.push(`CLAUDE_CODE_EFFORT_LEVEL=${conversationEffort}`);
}

/** Remove the Provider-level effort only when an Agent has an explicit value. */
export function removeProviderEffortEnv(
  lines: string[],
  effort: SdkAgentEffort | undefined,
): void {
  if (!effort) return;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.startsWith('CLAUDE_CODE_EFFORT_LEVEL=')) {
      lines.splice(index, 1);
    }
  }
}
