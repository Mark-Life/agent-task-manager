/**
 * One place where an agent's instructions are written, whichever of the two
 * homes they end up in.
 *
 * `./rules` holds what a mechanism enforces and `./instructions` holds what a
 * person may edit on disk, but both are text this package owns: the seeder
 * writes the second out of these constants rather than out of a literal of its
 * own, so a rule delivered by a file and the same rule inlined into a local
 * turn's prompt cannot come apart.
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

export {
  MANAGER_ANSWER_RULES,
  MANAGER_INSTRUCTIONS,
  MESSAGE_SHAPE_RULES,
  WORKSPACE_INSTRUCTIONS,
  WORKSPACE_RULES,
  WRITING_RULES,
} from "./instructions";
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
export type { ArtifactRulesInput } from "./rules";
export {
  artifactRulesOf,
  CREDENTIAL_RULES,
  MANAGER_RULES,
  SHARED_RULES,
  WORKER_RULES,
} from "./rules";
export type { UnreadInput, Watermark } from "./unread";
export { isAfterWatermark, nextWatermarkOf, unreadOf } from "./unread";
export type { MessageLabelInput, WorkerPromptInput } from "./worker";
export { buildWorkerPrompt, messageLabelOf, renderMessage } from "./worker";
