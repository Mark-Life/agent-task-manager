/**
 * The quota gate's surface.
 *
 * The service, its options and its decisions are exported because dispatch asks
 * it a question and the run lifecycle feeds it answers. The two usage readers
 * are exported for the tests that pin their field spellings against the captured
 * fixtures, and for the check script that proves a live account is readable.
 * The snapshot builders are exported because the document they produce is read
 * outside this process — by the gateway, off the data root — and a shape a test
 * cannot reach is a shape that drifts.
 *
 * The pause file, the cooldown ladder and the per-provider cache stay inside: a
 * caller that could write a pause record could pause a healthy provider without
 * a signal behind it, which is the one thing this module exists to be careful
 * about.
 */

export {
  type ClaudeUsageInput,
  type ClaudeUsageOptions,
  ClaudeUsageUnavailable,
  fetchClaudeUsage,
  OAUTH_BETA_HEADER,
  parseOauthUsage,
} from "./claude-usage";
export {
  type CodexUsageInput,
  type CodexUsageOptions,
  CodexUsageUnavailable,
  fetchCodexUsage,
  parseWhamUsage,
} from "./codex-usage";
export { GATED_PROVIDERS, type QuotaConfig, quotaConfig } from "./config";
export {
  detectRateLimitStatus,
  detectUsageLimitText,
  looksRateLimitShaped,
} from "./detect";
export {
  type AnnounceRequest,
  type DeferredNotice,
  type ErrorNotice,
  QuotaGate,
  type QuotaGateInterface,
  type QuotaGateOptions,
  type QuotaRequest,
  quotaGateLayer,
  quotaPausedError,
  type RateLimitNotice,
  type UsageReader,
} from "./gate";
export {
  type ProviderReading,
  providerReport,
  publishUsage,
  usagePathOf,
  usageSnapshot,
} from "./snapshot";
export {
  ADMIT,
  type ProviderUsage,
  QUOTA_WINDOWS,
  type QuotaAdmitted,
  type QuotaDecision,
  type QuotaDeferred,
  type QuotaWindow,
  UNAVAILABLE_USAGE,
  type WindowUsage,
} from "./types";
