/**
 * What this package lets the rest of the system do, and — more to the point —
 * what it does not.
 *
 * The harness turns a prompt and a workspace into a stream of normalized events,
 * and leaves a transcript and one `atm.turn` row behind. It has exactly one
 * consumer, the orchestrator, and one hard rule: it never imports
 * `@workspace/db`. A run happens inside a sandbox with no database handle, so
 * everything the harness knows travels out as events, files and environment
 * variables — which is what makes it extractable, and what makes a run
 * reproducible by hand.
 *
 * Exported: the provider registry and the vocabulary a caller needs to use it —
 * the normalized event union and its mapping onto the domain's run events, the
 * typed failures and their classification, the run layout, where each provider's
 * system-owned agent home lives, the transcript reader, the per-session usage
 * summary derived from it, the stop-hook rule, and the turn event's environment
 * contract.
 *
 * Not exported, deliberately, and each for its own reason.
 *
 * The two provider implementations. `claudeProvider` and `codexProvider` are
 * reachable only through the registry, because the registry is where the wide
 * event is attached: a caller holding a bare provider could run a turn that
 * leaves no row, and "exactly one row per invocation" is not a property that
 * survives being optional. Selection is by the `SessionProvider` on a session
 * row, which is the only thing the orchestrator has anyway.
 *
 * Each vendor's own protocol. The SDK message normalizers, the Codex JSONL
 * stepper, the per-vendor transcript parsers and both `PROVIDER_ID` constants
 * stay inside — they are the shape of somebody else's release notes, and two of
 * them share a name. `parseTranscript` dispatches on the provider, which is all
 * a reader needs.
 *
 * The Claude settings layer. `DEFAULT_CLAUDE_SETTINGS` and its merge are a
 * hardening decision about one vendor's permission model, applied by the harness
 * against the run's own environment; exported, they would be a permission set a
 * caller could relax from outside. What does leave is the name of the variable
 * an operator's overlay is read from, because the host has to know which
 * variable to forward into a container, and the error a bad overlay fails with.
 *
 * The turn event's emit path. `withTurnEvent`, its counters and its row builder
 * are how the registry instruments a run, not something to instrument with — the
 * one definition of "one row per turn" lives at one call site.
 *
 * The stop hook's executable lives at `scripts/stop-hook.ts` and is invoked as a
 * process by whichever provider was told where to find it. It is not an export:
 * the path belongs to the image, and {@link STOP_HOOK_COMMAND_ENV_VAR} is how
 * the two sides agree on it.
 *
 * The container's entrypoint. `src/entrypoint.ts` and its executable at
 * `scripts/turn.ts` are a process, not a library: they are bundled to one file
 * and mounted into a container, and a host that imported them would be running
 * a turn outside the sandbox the whole design rests on. What crosses the
 * boundary instead is `./turn-spec` — the spec, the result, their paths, and
 * the exit codes — which both sides read and neither owns.
 */

export {
  CLAUDE_SETTINGS_ENV_VAR,
  ClaudeSettingsInvalid,
} from "./claude-settings";
export {
  classify,
  describeError,
  errorClassOf,
  type FailureShape,
  HARNESS_ERROR_CLASSES,
  type HarnessError,
  HarnessErrorClass,
  INTERRUPT_REASONS,
  Interrupted,
  InterruptReason,
  NetworkFailed,
  NoTerminalEvent,
  outcomeOfClass,
  ProcessFailed,
  ProviderCrashed,
  QuotaExhausted,
  RateLimited,
  TimedOut,
  TURN_OUTCOMES,
  TurnOutcome,
  Unauthenticated,
} from "./errors";
export {
  AgentEvent,
  type AgentEventKind,
  AgentEventRecord,
  costUsdOf,
  isTerminal,
  RATE_LIMIT_STATUSES,
  RateLimitStatus,
  runEventKindOf,
  runOutcomeOf,
} from "./events";
export {
  type CodexExecutorConfig,
  claudeExecutorMcpServers,
  codexExecutorConfig,
  EXECUTOR_KEY_ENV_VAR,
  EXECUTOR_SERVER_NAME,
  EXECUTOR_TOOL_PREFIX,
  EXECUTOR_URL_ENV_VAR,
  type ExecutorMcp,
  type ExecutorMcpInput,
  makeExecutorMcp,
  readExecutorMcp,
} from "./executor-mcp";
export {
  AGENT_HOME_DIR_ENV_VAR,
  AGENT_HOME_ENV_VAR,
  agentHomeEnvAt,
  agentHomeLoginHint,
  CONTAINER_RUN_DIR,
  containerRunLayout,
  defaultAgentHomeDirOf,
  EVENT_LOG_FILE,
  hostRunLayout,
  RUNS_SEGMENT,
  type RunDirInput,
  type RunLayout,
  runDirOf,
  runLayout,
  TRANSCRIPT_GLOB,
  transcriptDirOf,
} from "./paths";
export {
  type AgentProvider,
  type Choice,
  makeProviderRegistry,
  type ProviderCapabilities,
  ProviderRegistry,
  type ProviderRegistryInterface,
  type ProviderTable,
  type RunOptions,
} from "./provider";
export {
  providerRegistry,
  providerRegistryLayer,
  providerTable,
} from "./registry";
export {
  GROWTH_POINT_LIMIT,
  LARGEST_ENTRY_LIMIT,
  type SummarizeInput,
  summarizeSession,
} from "./session-usage";
export {
  ALLOW_TURN_END,
  decideStop,
  MESSAGE_MARKER_ENV_VAR,
  MESSAGE_MARKER_FILE,
  messageMarkerPath,
  messageMarkerPathOf,
  messageRuleApplies,
  NO_MESSAGE_REFUSAL,
  parseStopHookPayload,
  STOP_ALLOW_REASONS,
  STOP_HOOK_COMMAND_ENV_VAR,
  StopAllowReason,
  type StopDecision,
  type StopDecisionInput,
  StopHookPayload,
  StopHookResponse,
  stopHookCommand,
  stopHookResponseOf,
} from "./stop-hook";
export {
  EMPTY_TRANSCRIPT,
  type FindTranscriptInput,
  findTranscript,
  parseTranscript,
  readTranscript,
  readTranscriptAt,
  TRANSCRIPT_ROLES,
  type Transcript,
  TranscriptEntry,
  type TranscriptError,
  type TranscriptFile,
  TranscriptNotFound,
  TranscriptRole,
  TranscriptUnreadable,
  TranscriptUsage,
  transcriptChars,
} from "./transcript";
export {
  readTurnIdentity,
  TURN_ENV_VARS,
  TURN_EVENT_MARKER,
  TurnEvent,
  type TurnEventInput,
  type TurnIdentity,
} from "./turn-event";
export {
  CONTAINER_ENTRYPOINT_COMMAND,
  CONTAINER_ENTRYPOINT_PATH,
  containerEntrypointArgs,
  containerStopHookCommand,
  ENTRYPOINT_BUNDLE_FILE,
  ENTRYPOINT_SEGMENT,
  entrypointBundlePathOf,
  exitCodeOf,
  MCP_SERVERS_FILE,
  mcpServersPathOf,
  STOP_HOOK_FLAG,
  TURN_EXIT_CODE,
  TURN_EXIT_REASONS,
  TURN_LEDGER_SERVICE,
  TURN_RESULT_FILE,
  TURN_SPEC_ENV_VAR,
  TURN_SPEC_FILE,
  TURN_SPEC_FLAG,
  TurnExitReason,
  TurnResult,
  TurnSpec,
  TurnSpecIdentity,
  turnResultPathOf,
  turnSpecPathOf,
} from "./turn-spec";
