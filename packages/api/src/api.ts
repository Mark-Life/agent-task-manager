import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { ArtifactsGroup } from "./groups/artifacts";
import { HealthGroup } from "./groups/health";
import { MessagesGroup } from "./groups/messages";
import { ProjectsGroup } from "./groups/projects";
import { ProposalsGroup } from "./groups/proposals";
import { RunCommandsGroup } from "./groups/run-commands";
import { RunsGroup } from "./groups/runs";
import { SessionsGroup } from "./groups/sessions";
import { TasksGroup } from "./groups/tasks";
import { ThreadsGroup } from "./groups/threads";
import { UsageGroup } from "./groups/usage";

/**
 * The whole HTTP surface of the system, as a contract.
 *
 * Definition only — no handlers live here. Servers implement it group by group
 * with `HttpApiBuilder.group`; clients derive from the same value with
 * `HttpApiClient.make`, so both sides move together. The generated OpenAPI
 * document is the third consumer, and the reason this is HttpApi rather than
 * RPC: everything the backend can do has to be visible operation by operation
 * for an external agent to hold it as tools.
 *
 * Two conventions run through every group.
 *
 * **The workspace is never addressed.** It is not a path segment and not a body
 * field; it comes off the credential, so no caller can name a workspace it
 * cannot read and no handler can forget to scope a query.
 *
 * **Everything a task owns is nested under `/tasks/:taskId`.** That is what
 * lets a run's task-bound token be checked once, in the access middleware,
 * against the path — rather than in each of the handlers that would otherwise
 * have to remember.
 *
 * A conversation with the manager is the one thing that is not a task's, so
 * `/threads` is rooted beside `/tasks` rather than under it: the same thread is
 * reachable from Telegram and from anything else holding a credential, and it
 * would still exist if the board were empty.
 *
 * Creates answer 200 carrying the created row rather than 201. The body is the
 * same entity every read of it returns and the generated document names that
 * shape once; a status-annotated copy of a schema is a second component with
 * identical contents under a different name, on every create.
 */
export class Api extends HttpApi.make("atm")
  .add(
    HealthGroup,
    ProjectsGroup,
    TasksGroup,
    MessagesGroup,
    SessionsGroup,
    RunsGroup,
    RunCommandsGroup,
    ArtifactsGroup,
    ProposalsGroup,
    ThreadsGroup,
    UsageGroup
  )
  .annotate(OpenApi.Title, "Agent Task Manager")
  .annotate(OpenApi.Version, "0.0.1")
  .annotate(
    OpenApi.Description,
    "Task board, agent runs and their artifacts. Every operation is scoped to the workspace its credential belongs to."
  ) {}

/**
 * Derive the OpenAPI 3.1 document for {@link Api}.
 *
 * Pure and synchronous. Servers usually let `HttpApiBuilder.layer` mount the
 * spec; call this directly to write it to disk or hand it to an external
 * consumer.
 */
export const makeOpenApiSpec = () => OpenApi.fromApi(Api);
