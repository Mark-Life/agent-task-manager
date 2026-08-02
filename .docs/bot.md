# Telegram bot (`bun run bot:start`, `bun run bot:check`)

`apps/bot` is an interface and nothing else: intake, rendering, queueing, buttons. It starts no
container, builds no prompt, mints no turn credential and holds no turn in a fiber. An inbound
message becomes a `chat_message` row; the insert trigger wakes the loop, which runs the turn as
a `role: manager` run and writes the answer back as another row. The bot renders that row.

**The boundary.** The bot owns the conversation and the gateway owns the board. `chat_thread`,
`chat_message` and `chat_notification` are read and written directly, on the bot's own pool.
Every project, task, comment and run command a *tapped button* asks for goes over the gateway
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
naming the thread, so the turn closes as `interrupted` and everything said since it started is
still unread — which is what the next turn reads. Nothing coalesces messages in the bot: a
watermark does it, the same one that gives a resumed worker every comment since it last looked.
A conversation opened over `POST /threads` from a dashboard behaves identically, because it is
the same row and the same trigger.

**What it says without being asked.** A run that finishes, fails or lands in review wakes the
listener on `atm_run_event` — the same channel the loop publishes on, not a second poller. A
terminal event carrying a task is a notice into the conversation that asked for the work, with
*Start* / *Approve* / *Comment* buttons; one carrying none is a manager turn ending, and its
answer goes into its thread. `chat_notification` is a claim ledger keyed on
`${kind}:${taskId}:${runId}`, so a restart between claim and send re-sends rather than losing
it, and a duplicate is the failure it chooses. Beside it, a scan looks at live runs every
minute for a run repeating the same tool calls with no file edit — surfaced, never acted on.

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
answered with, that `/new` and a *Switch* button move the current thread, that a run-finished
notice renders, and that the stuck rule fires on a repeating window and holds off on one that
edited a file.

