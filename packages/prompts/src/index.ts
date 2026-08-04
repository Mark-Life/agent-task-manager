/**
 * One place where an agent's instructions live.
 *
 * A worker and a manager are the same runtime under one role, so their prompts
 * are the same assembly under one role too: standing rules, the conversation
 * the session has not read yet, and the directories it was given. What a role
 * may change is exactly two things — its own rules block, and how one line of
 * conversation is attributed. Everything else in here is shared, and that is
 * what stops the two prompts from drifting into two systems.
 *
 * The package is pure on purpose. Nothing here opens a database, reads a config
 * or starts a container, so a check script and a unit test can assert the text
 * an agent will actually be handed without building a layer stack. Fetching the
 * rows and advancing the watermark belongs to the orchestrator, which is the
 * only impure half there is.
 */

export type {
  ManagerPromptInput,
  RenderableMessage,
} from "./manager";
export {
  buildManagerPrompt,
  FRESH_HISTORY_MESSAGES,
  renderChatMessage,
} from "./manager";
export type {
  PlacementSectionInput,
  PromptMode,
  RunPlacement,
  RunPrompt,
  SpeechInput,
} from "./render";
export {
  conversation,
  joinSections,
  placementSection,
  promptOf,
  section,
  speech,
} from "./render";
export {
  ARTIFACT_RULES,
  MANAGER_RULES,
  SHARED_RULES,
  WORKER_RULES,
} from "./rules";
export type { UnreadInput, Watermark } from "./unread";
export { isAfterWatermark, nextWatermarkOf, unreadOf } from "./unread";
export type { CommentLabelInput, WorkerPromptInput } from "./worker";
export { buildWorkerPrompt, commentLabelOf, renderComment } from "./worker";
