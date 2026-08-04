/**
 * Every button this bot puts in front of a person.
 *
 * Two kinds, and they are not interchangeable. The **reply keyboard** sits
 * under the text box, is per chat and persists across messages: it is the menu,
 * and every key on it stands for a slash command. The **inline keyboards** are
 * attached to one message and act on the thing that message is about — this
 * task, this thread, this page.
 *
 * The reply keyboard is not a second command surface. A tap on it sends the
 * button's label as an ordinary text message, which the rewrite middleware
 * turns back into the slash command it stands for, so `/tasks` and the *Tasks*
 * key reach the same handler and there is one implementation of each command,
 * not two. {@link BUTTON_COMMANDS} is the whole mapping; adding a key without
 * adding its command is a key that sends the model the word "Tasks".
 *
 * Which buttons a task gets is decided by its status, here, once. A *Start*
 * button on a task already in progress is a button whose only outcome is the
 * gateway's rejection, and a person who taps it learns nothing except that the
 * bot does not know what it is showing them.
 */

import type { TaskId, TaskStatus, ThreadId } from "@workspace/domain";
import { InlineKeyboard, Keyboard, type NextFunction } from "grammy";
import { encodeCallbackData } from "./callback-data";
import type { BotContext } from "./context";

/** The reply-keyboard label for each command it stands for. */
export const BUTTON_COMMANDS: Record<string, string> = {
  Board: "/board",
  New: "/new",
  Status: "/status",
  Stop: "/stop",
  Tasks: "/tasks",
  Threads: "/threads",
};

/**
 * The persistent menu under the text box.
 *
 * Six keys, because a reply keyboard covers the conversation on a phone and
 * every extra row is a message the person has to scroll past. The rest of the
 * surface lives behind `/help`.
 */
export const mainKeyboard = new Keyboard()
  .text("Tasks")
  .text("Board")
  .row()
  .text("Threads")
  .text("Status")
  .row()
  .text("New")
  .text("Stop")
  .row()
  .resized()
  .persistent();

/** The slash command a reply-keyboard label stands for, or null for ordinary text. */
export const commandForButton = (text: string | undefined) =>
  text === undefined ? null : (BUTTON_COMMANDS[text] ?? null);

/**
 * Middleware that turns a tap on the reply keyboard into the slash command it
 * stands for, by rewriting the incoming message in place.
 *
 * It really does mutate the update — the text is replaced and a `bot_command`
 * entity is fabricated over it — because that is what makes grammy's own
 * `bot.command` matching fire. The alternative is a second dispatch path
 * beside the command handlers, which is two implementations of `/tasks` that
 * drift.
 *
 * Worth knowing while debugging: below this point, a message whose text was
 * "Tasks" reads as "/tasks", and nothing downstream can tell which it was.
 */
export const rewriteButtonCommands = (ctx: BotContext, next: NextFunction) => {
  const { message } = ctx;
  const command = commandForButton(message?.text);
  if (message !== undefined && command !== null) {
    message.text = command;
    message.entities = [
      { length: command.length, offset: 0, type: "bot_command" },
    ];
  }
  return next();
};

/**
 * The buttons a task gets, given where it sits and whether a run is live.
 *
 * Read as a table rather than as branching logic: each column of the board
 * offers the move that column actually allows, plus *Comment*, which is the one
 * action that is legal everywhere.
 */
const taskActions = (options: {
  readonly hasLiveRun: boolean;
  readonly status: TaskStatus;
}) => {
  const { hasLiveRun, status } = options;
  if (status === "in_progress") {
    return hasLiveRun
      ? ([
          { label: "Stop", verb: "rstop" },
          { label: "Review", verb: "trev" },
        ] as const)
      : ([
          { label: "Review", verb: "trev" },
          { label: "Rerun", verb: "rrun" },
        ] as const);
  }
  if (status === "review") {
    return [
      { label: "Approve", verb: "tdone" },
      { label: "Rerun", verb: "rrun" },
    ] as const;
  }
  if (status === "done") {
    return [{ label: "Rerun", verb: "rrun" }] as const;
  }
  return [{ label: "Start", verb: "tprog" }] as const;
};

/**
 * The inline keyboard under a message about one task: the moves its status
 * allows, *Comment*, and a link into the dashboard when there is a public URL
 * to link to.
 *
 * The link is a `url` button rather than a line of text because Telegram's own
 * link preview would otherwise attach itself to the message and push the
 * summary off the screen.
 */
export const taskKeyboard = (options: {
  readonly hasLiveRun: boolean;
  readonly status: TaskStatus;
  readonly taskId: TaskId;
  readonly taskUrl?: string | null;
}) => {
  const { hasLiveRun, status, taskId, taskUrl = null } = options;
  const keyboard = new InlineKeyboard([]).row(
    ...taskActions({ hasLiveRun, status }).map((action) =>
      InlineKeyboard.text(
        action.label,
        encodeCallbackData({ kind: "task", taskId, verb: action.verb })
      )
    ),
    InlineKeyboard.text(
      "Comment",
      encodeCallbackData({ kind: "task", taskId, verb: "cadd" })
    )
  );
  return taskUrl === null
    ? keyboard
    : keyboard.row(InlineKeyboard.url("Open", taskUrl));
};

/**
 * The keyboard on a notification about a run: the three things a person wants
 * at the moment they are told a run ended, and nothing that moves the board.
 * Approving from a notification is a decision that belongs on the task message,
 * where the status is visible.
 */
export const runNoticeKeyboard = (options: {
  readonly taskId: TaskId;
  readonly taskUrl?: string | null;
}) => {
  const { taskId, taskUrl = null } = options;
  const keyboard = new InlineKeyboard([]).row(
    InlineKeyboard.text(
      "Stop",
      encodeCallbackData({ kind: "task", taskId, verb: "rstop" })
    ),
    InlineKeyboard.text(
      "Rerun",
      encodeCallbackData({ kind: "task", taskId, verb: "rrun" })
    ),
    InlineKeyboard.text(
      "Comment",
      encodeCallbackData({ kind: "task", taskId, verb: "cadd" })
    )
  );
  return taskUrl === null
    ? keyboard
    : keyboard.row(InlineKeyboard.url("Open", taskUrl));
};

/** One row per thread, each tap making that thread the chat's current one. */
export const threadSwitchKeyboard = (
  threads: ReadonlyArray<{ readonly id: ThreadId; readonly label: string }>
) => {
  const keyboard = new InlineKeyboard([]);
  for (const thread of threads) {
    keyboard.row(
      InlineKeyboard.text(
        thread.label,
        encodeCallbackData({
          kind: "thread",
          threadId: thread.id,
          verb: "thsw",
        })
      )
    );
  }
  return keyboard;
};
