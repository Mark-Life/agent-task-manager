# Telegram bot (`bun run bot:start`, `bun run bot:check`)

`apps/bot` is an interface and nothing else: intake, rendering, queueing, buttons. It starts no
container, builds no prompt, mints no turn credential and holds no turn in a fiber. An inbound
message becomes a `chat_message` row; the insert trigger wakes the loop, which runs the turn as
a `role: manager` run and writes the answer back as another row. The bot renders that row.

**The boundary.** The bot owns the conversation and the gateway owns the board. `chat_thread`,
`chat_message` and `chat_notification` are read and written directly, on the bot's own pool.
Every project, task, message and run command a *tapped button* asks for goes over the gateway
with a freshly minted `manager` token carrying the conversation that caused it, so
`actor_thread_id` lands on the audit row and a later notice about that task comes back to the
same chat. There is no third path, and it is a compile error rather than a rule: the bot's
store provides no `CurrentActor`, so a board write from this app names the missing service.

**Who it answers.** `TELEGRAM_ALLOWLIST`, as `telegramUserId:workspaceId:userId` entries
separated by commas. There is no link-code flow. A malformed entry fails the boot rather than
dropping one person's messages silently, and an account that is not on the list gets one
sentence and one `atm.chat` row saying `not_allowed`.

**One live turn per conversation.** A message that arrives while a turn is running is stored
anyway and answered with one line saying how many are waiting, carrying a *Force send* button;
a second one edits that line rather than sending another. The button files a `stop` run command
naming the thread, so the turn closes as `stopped` and everything said since it started is
still unread — which is what the next turn reads. Nothing coalesces messages in the bot: a
watermark does it, the same one that gives a resumed worker every message since it last looked.
A conversation opened over `POST /threads` from a dashboard behaves identically, because it is
the same row and the same trigger.

**Compose.** `/compose` is the one mode where a message does not become a row.
The bot answers with a message carrying *Send* and *Cancel*, and until one of
them is tapped everything the chat sends is resolved as usual — a voice note is
still transcribed and still echoed back, a forward still keeps its sender — and
then held in this process instead of stored. Nothing runs. *Send* writes the
whole collection as a single `chat_message`, so it is one insert, one trigger
and one turn; *Cancel* drops it and writes nothing at all. Slash commands are
not collected: `/stop` and `/tasks` are not things a person is saying.

The batch's attribution goes into the body, because a row has one `intake_kind`
and one `forward_from` and a batch has as many as it has pieces — each piece is
written under a `[message 2 of 3 · forwarded from Ada]` header, and the row's
own kind is `compose`, which is what the manager's prompt renders as "several
messages, sent together". A batch of exactly one piece is stored as though it
had been sent alone, so `/compose` around a single message changes nothing.

Order is Telegram's `message_id`, not the order this process finished with each
one: a voice note takes seconds to transcribe and the sentence typed behind it
does not. The buffer is per chat, in memory, and idle for thirty minutes ends
it — the same reasoning as the armed *Message* beside it, and the message that
finds a session expired is told so and then handled on its own. A second
`/compose` keeps the words and moves the buttons to the bottom of the chat,
stripping the old message's, so there is never more than one live *Send*.

**What it says without being asked.** A run that finishes, fails or lands in review wakes the
listener on `atm_run_event` — the same channel the loop publishes on, not a second poller. A
terminal event carrying a task is a notice into the conversation that asked for the work, with
*Start* / *Approve* / *Message* buttons; one carrying none is a manager turn ending, and its
answer goes into its thread. `chat_notification` is a claim ledger keyed on
`${kind}:${taskId}:${runId}`, so a restart between claim and send re-sends rather than losing
it, and a duplicate is the failure it chooses. Beside it, a scan looks at live runs every
minute for a run repeating the same tool calls with no file edit — surfaced, never acted on.

**What it says about itself.** A process start puts one line into every allow-listed chat for
the workspaces it serves — the same resolution a notice takes when no conversation asked for it,
and the reason no chat id has to be stored anywhere. A graceful stop puts one out on the way,
from a finaliser that a killed process never reaches, which is how the next start tells a deploy
(`system_down` newer than `system_up`, and the gap between them is the downtime) from a crash
(no such row, so no duration is claimed). Both are `chat_notification` rows with a null
`task_id`, keyed `${kind}:${bucket}` where the bucket is `BOT_ANNOUNCE_QUIET_MS` wide, so a
crash loop or a rolling deploy is one line per window and not one per process. A reconnect never
reaches any of this: grammy re-establishes a dropped long-poll inside `bot.start`, so a new
process is the only event there is. `BOT_ANNOUNCE_RESTART=false` turns both off.

There is no `/clear`. A conversation's session is a row on the thread, so the honest way to
start from nothing is `/new`, whose first turn is prompted from the whole thread with no
session behind it. `BOT_GATEWAY_URL` is the gateway as the bot process reaches it; the loop's
`ORCHESTRATOR_GATEWAY_URL` is a different address for the same server, resolved from inside a
container.

`bun run bot:check` proves the wiring without a token and without one call to Telegram: the real
handlers, registered in the real order on a real grammy `Bot`, driven with synthetic updates
through `bot.handleUpdate`, against a real Postgres. Every Telegram API call is answered by a
transformer on `bot.api`, and the gateway client is the one substitution the composition root
allows. It asserts that a refused account leaves a row with no identity on it, that a text
message opens a conversation and stores it, that a message sent mid-turn is stored and answered
with a *Force send* line a second one edits rather than repeats, that the tap asks the board to
stop *that thread* by name, that the finished turn's own row is what the conversation is
answered with, that a text, a forward and a voice note sent into `/compose` leave no row at all
and then become exactly one carrying all three in order, that *Cancel* leaves none, that `/new`
and a *Switch* button move the current thread, that a run-finished notice renders, that a start
announces itself into the allow-listed chat and leaves a claim naming no task while a second
start inside the window says nothing, that a graceful stop says so and the start after it
reports the downtime rather than a crash, and that the stuck rule fires on a repeating window
and holds off on one that edited a file.

