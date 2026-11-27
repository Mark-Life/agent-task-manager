/**
 * The agent filesystem, skills and the manager conversations.
 */

import { Api, type FileEntry, type ThreadMessage } from "@workspace/api";
import {
  type FileScope,
  fileScopeAddressOf,
  newChatMessageId,
  newRunCommandId,
  newThreadId,
} from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { DEMO_USER, DEMO_WORKSPACE, now } from "@/demo/ids";
import { db, find, millis, update } from "@/demo/store";

const SEPARATOR = "/";

const filesOf = (scope: FileScope) => {
  const address = fileScopeAddressOf(scope);
  db.files[address] ??= {};
  return db.files[address];
};

const entry = (
  path: string,
  kind: FileEntry["kind"],
  bytes: number | null
): FileEntry => {
  const name = path.split(SEPARATOR).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return {
    bytes,
    ext: kind === "file" && dot > 0 ? name.slice(dot + 1) : null,
    kind,
    modifiedAt: now(),
    name,
    path,
    target: null,
    targetOutsideScope: false,
  };
};

/** The direct children of `dir`, folders first. */
const listDir = (scope: FileScope, dir: string) => {
  const prefix = dir === "" ? "" : `${dir}${SEPARATOR}`;
  const children = new Map<string, FileEntry>();
  for (const [path, content] of Object.entries(filesOf(scope))) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const [head, ...rest] = path.slice(prefix.length).split(SEPARATOR);
    if (head === undefined || head === "") {
      continue;
    }
    const childPath = `${prefix}${head}`;
    children.set(
      childPath,
      rest.length > 0
        ? entry(childPath, "directory", null)
        : entry(childPath, "file", new TextEncoder().encode(content).length)
    );
  }
  const folderRank = (child: FileEntry) => (child.kind === "directory" ? 0 : 1);
  return [...children.values()].sort(
    (a, b) => folderRank(a) - folderRank(b) || a.name.localeCompare(b.name)
  );
};

const write = (scope: FileScope, path: string, content: string) => {
  filesOf(scope)[path] = content;
  return entry(path, "file", new TextEncoder().encode(content).length);
};

export const filesHandlers = HttpApiBuilder.group(Api, "files", (handlers) =>
  handlers
    .handle("list", ({ params, query }) =>
      Effect.sync(() => listDir(params.scope, query.path ?? ""))
    )
    .handle("read", ({ params, query }) =>
      Effect.sync(() => {
        const content = filesOf(params.scope)[query.path] ?? "";
        return {
          bytes: new TextEncoder().encode(content).length,
          content,
          encoding: "utf8" as const,
          path: query.path,
        };
      })
    )
    .handle("write", ({ params, payload }) =>
      Effect.sync(() => write(params.scope, payload.path, payload.content))
    )
    .handle("createDirectory", ({ params, payload }) =>
      Effect.sync(() => {
        write(params.scope, `${payload.path}/.keep`, "");
        return entry(payload.path, "directory", null);
      })
    )
    .handle("createLink", ({ payload }) =>
      Effect.sync(() => ({
        ...entry(payload.path, "symlink", null),
        target: payload.target,
      }))
    )
    .handle("move", ({ params, payload }) =>
      Effect.sync(() => {
        const files = filesOf(params.scope);
        const content = files[payload.from] ?? "";
        delete files[payload.from];
        return write(params.scope, payload.to, content);
      })
    )
    .handle("delete", ({ params, query }) =>
      Effect.sync(() => {
        delete filesOf(params.scope)[query.path];
      })
    )
);

export const skillsHandlers = HttpApiBuilder.group(Api, "skills", (handlers) =>
  handlers
    .handle("list", () => Effect.succeed([]))
    .handle("install", ({ payload }) =>
      Effect.die(new Error(`Installing ${payload.repoUrl} is off in the demo.`))
    )
    .handle("checkUpdate", () =>
      Effect.die(new Error("No skills in the demo."))
    )
    .handle("applyUpdate", () =>
      Effect.die(new Error("No skills in the demo."))
    )
    .handle("uninstall", () => Effect.void)
);

/** The manager's reply to anything typed in the demo. */
const DEMO_REPLY =
  "This is a demo with no agents behind it, so nothing runs. On the real board I would file that as a task and tell you when an agent picks it up.";

const threadMessage = (
  fields: Pick<ThreadMessage, "body" | "role" | "threadId">
): ThreadMessage => ({
  ...fields,
  createdAt: now(),
  forwardFrom: null,
  id: newChatMessageId(),
  intakeKind: fields.role === "user" ? "text" : null,
  runId: null,
  telegramChatId: null,
  telegramMessageId: null,
  transcriptChars: null,
  workspaceId: DEMO_WORKSPACE,
});

export const threadsHandlers = HttpApiBuilder.group(
  Api,
  "threads",
  (handlers) =>
    handlers
      .handle("list", ({ query }) =>
        Effect.sync(() =>
          db.threads
            .filter((thread) => thread.status === (query.status ?? "active"))
            .sort((a, b) => millis(b.lastMessageAt) - millis(a.lastMessageAt))
        )
      )
      .handle("create", ({ payload }) =>
        Effect.sync(() => {
          const at = now();
          db.threads = db.threads.map((other) => ({
            ...other,
            isCurrent: false,
          }));
          const thread = {
            chatId: null,
            createdAt: at,
            id: newThreadId(),
            isCurrent: true,
            lastMessageAt: at,
            provider: payload.provider ?? "claude",
            status: "active" as const,
            title: payload.title ?? null,
            updatedAt: at,
            userId: DEMO_USER,
            workspaceId: DEMO_WORKSPACE,
          };
          db.threads.push(thread);
          return thread;
        })
      )
      .handle("get", ({ params }) =>
        Effect.map(find(db.threads, "thread", params.threadId), (thread) => ({
          liveRunId: null,
          thread,
        }))
      )
      .handle("patch", ({ params, payload }) =>
        Effect.map(find(db.threads, "thread", params.threadId), (thread) =>
          update(db.threads, { ...thread, ...payload, updatedAt: now() })
        )
      )
      .handle("messages", ({ params }) =>
        Effect.sync(() => ({
          messages: db.threadMessages.filter(
            (message) => message.threadId === params.threadId
          ),
          nextOffset: null,
        }))
      )
      .handle("postMessage", ({ params, payload }) =>
        Effect.sync(() => {
          const message = threadMessage({
            body: payload.body,
            role: "user",
            threadId: params.threadId,
          });
          db.threadMessages.push(
            message,
            threadMessage({
              body: DEMO_REPLY,
              role: "manager",
              threadId: params.threadId,
            })
          );
          return { message, queued: false };
        })
      )
      .handle("runs", () => Effect.succeed([]))
      .handle("stop", ({ params }) =>
        Effect.sync(() => {
          const at = now();
          return {
            actorKind: "human" as const,
            actorRunId: null,
            actorSessionId: null,
            actorUserId: DEMO_USER,
            consumedAt: at,
            createdAt: at,
            id: newRunCommandId(),
            payload: { kind: "stop" as const },
            rejectedReason: null,
            runId: null,
            status: "consumed" as const,
            taskId: null,
            threadId: params.threadId,
            traceparent: null,
            updatedAt: at,
            workspaceId: DEMO_WORKSPACE,
          };
        })
      )
);
