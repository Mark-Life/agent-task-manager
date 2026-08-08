/**
 * Where the groups meet.
 *
 * One layer per group of the contract, merged in the order the contract
 * declares them. `HttpApiBuilder.layer` will not build until every group is
 * present, which is the property worth having: adding a group to
 * `@workspace/api` breaks this file until somebody implements it, rather than
 * quietly shipping a documented operation that 404s.
 *
 * Handlers hold no rules of their own. Each decodes its input, reads the
 * principal, calls a repository, and maps the store's failures onto the wire
 * failures `@workspace/api` declares — everything else belongs behind the
 * repository, where the audit row is written in the same transaction.
 */

import { Layer } from "effect";
import { artifactsHandlers } from "./artifacts";
import { filesHandlers } from "./files";
import { healthHandlers } from "./health";
import { messagesHandlers } from "./messages";
import { projectsHandlers } from "./projects";
import { proposalsHandlers } from "./proposals";
import { runCommandsHandlers } from "./run-commands";
import { runsHandlers } from "./runs";
import { sessionsHandlers } from "./sessions";
import { skillsHandlers } from "./skills";
import { tasksHandlers } from "./tasks";
import { threadsHandlers } from "./threads";
import { usageHandlers } from "./usage";

/** Every group of the contract, implemented. */
export const handlersLayer = Layer.mergeAll(
  healthHandlers,
  projectsHandlers,
  tasksHandlers,
  messagesHandlers,
  sessionsHandlers,
  runsHandlers,
  runCommandsHandlers,
  artifactsHandlers,
  proposalsHandlers,
  filesHandlers,
  skillsHandlers,
  threadsHandlers,
  usageHandlers
);
