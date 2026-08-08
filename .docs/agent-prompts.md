# Every prompt and rule an agent sees

One index of every piece of text that can reach a model this system runs — the manager agent,
a worker agent, and the hook that talks to both mid-turn — with a link that opens directly on
the text and a line saying who reads it and when.

It is ordered the way an agent meets it: how the prompt is assembled, then the standing rules,
then the per-role rules, then everything injected at dispatch time, then what arrives mid-turn,
then what the provider, the checkout, the image and the MCP layer add on top.

**Link convention.** Anything that is one export inside a larger file is linked as a permalink
with a line range, pinned to `8d71b61` — main at the time of writing — so the range keeps
pointing at the text. Whole files that are themselves the prompt (`AGENTS.md`, a `SKILL.md`) are
linked on `main`. A pinned range can go stale after an edit; the un-pinned file link beside each
section is the one to follow if it does.

**Nothing here is stored in a database or read off an operator's disk.** Every prompt constant in
this system is versioned with the code, deliberately — the reasoning is in the module header of
[`packages/prompts/src/rules.ts`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/rules.ts#L1-L69).
The exceptions are all outside this repository and are listed in §7 and §8: the vendor's own
system prompt, the operator's shared skills directory, and whatever sits in the agent home.

---

## 0. The order an agent meets it

| # | What | Worker | Manager |
|---|------|--------|---------|
| 1 | Provider system prompt (vendor preset) | ✅ | ✅ |
| 2 | Repo-level instructions loaded by the CLI (`CLAUDE.md` / `AGENTS.md`, skills) | ✅ | only in its scratch dir, so normally none |
| 3 | MCP tool descriptions (`atm`, `executor`) | ✅ | ✅ |
| 4 | Task title, brief, acceptance / conversation so far | ✅ | ✅ |
| 5 | `SHARED_RULES` | ✅ | ✅ |
| 6 | `ARTIFACT_RULES` | ✅ | ❌ |
| 7 | `CREDENTIAL_RULES` | only with a repo | ❌ |
| 8 | `WORKER_RULES` / `MANAGER_RULES` | worker | manager |
| 9 | `NO_COMMENT_REFUSAL`, mid-turn, at most once | ✅ | ❌ (hook not registered) |

Items 1–3 are the provider's doing and land before the prompt. Items 4–8 are one string built by
`@workspace/prompts` and handed over as the turn's first user message. Item 9 arrives during the
turn, as the model's next prompt, if it tries to stop without commenting.

---

## 1. Where the assembly happens

A prompt in this system is never one constant. It is a list of fragments joined at run time, and
the join is the thing to read first — a link to a constant is not much use without it.

File: [`packages/prompts/`](https://github.com/Mark-Life/agent-task-manager/tree/main/packages/prompts/src)
(pure — strings in, strings out, no clock, no database) and
[`packages/orchestrator/src/prompt.ts`](https://github.com/Mark-Life/agent-task-manager/blob/main/packages/orchestrator/src/prompt.ts)
(the impure half).

| Link | What it does |
|------|--------------|
| [`buildRunPrompt`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/prompt.ts#L148-L251) | **The dispatch-time entry point.** Fetches the rows the session has not read, picks worker or manager by `attached.role`, renders, then advances the session's watermark in the same operation. Called once per run from [`run.ts#L353-L360`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/run.ts#L353-L360), after the directories exist, because the prompt names them. |
| [`placementOf`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/prompt.ts#L76-L102) | Decides which spelling of the paths goes in the prompt: the container's fixed mount points, or the host paths a `local` run actually sees. |
| [`unreadOf`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/unread.ts#L59-L65) / [`nextWatermarkOf`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/unread.ts#L81-L86) | What "has not been read yet" means, over comments and chat messages alike. A null watermark yields the conversation from the beginning, which is how a fresh session gets it with no special case. |
| [`freshPrompt` (worker)](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L148-L168) | **The concatenation for a first worker turn: eight fragments through `joinSections`.** Title, brief, acceptance, project, placement, `CREDENTIAL_RULES` (only when there is a repo), `ARTIFACT_RULES`, `SHARED_RULES`, the comment thread, then `WORKER_RULES` under a `## Before you finish` heading. |
| [`resumedPrompt` (worker)](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L179-L192) | A resumed worker turn: a `— continued` heading, one sentence, the new comments, and `WORKER_RULES` again. The rules are *not* restated — they are in the session's own history. The comment rule is the one exception, because the hook that enforces it has no memory of the session either. |
| [`freshPrompt` (manager)](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/manager.ts#L112-L125) | The concatenation for a first manager turn: `MANAGER_RULES`, `SHARED_RULES`, the placement section with no repo, the last 40 messages, and the answer instruction. |
| [`resumedPrompt` (manager)](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/manager.ts#L135-L148) | A resumed manager turn: heading, one sentence, what has been said since, the answer instruction. |
| [`joinSections`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/render.ts#L16-L17), [`section`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/render.ts#L20-L21), [`speech`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/render.ts#L37-L38), [`conversation`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/render.ts#L41) | The four primitives every fragment above is glued with. `joinSections` drops nulls, which is how a fragment a run did not earn disappears rather than rendering empty. |
| [`promptOf`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/render.ts#L119-L122) | Wraps the finished text with its own character count. `promptChars` on a run's telemetry is measured here; the text itself never reaches an event. |
| [`specFor`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/container-turn.ts#L135-L160) | How the finished string reaches a containerised run: it travels in the turn spec file on the run mount, and nowhere else. |
| [`buildQuery`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/claude.ts#L306-L337) | How it reaches the model on the Claude side: `prompt` is the built string, and everything else on this object is context the provider adds around it (§6). |

The exported surface, if you want the whole list of what `@workspace/prompts` can produce, is
[`index.ts`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/index.ts#L18-L52).

---

## 2. Standing rules, shared

File: [`packages/prompts/src/rules.ts`](https://github.com/Mark-Life/agent-task-manager/blob/main/packages/prompts/src/rules.ts).
Each of these is one exported constant, dropped into the prompt whole.

### [`SHARED_RULES`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/rules.ts#L81-L85) — "What counts as finishing"

Every fresh run of either role, in the situating prompt, after the role's own rules. Not repeated
on a resumed turn.

### [`ARTIFACT_RULES`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/rules.ts#L100-L102) — "What survives this run"

Every fresh worker run, and no manager run — a manager's only writable directory is its scratch
directory and nothing is promoted out of it.

### [`CREDENTIAL_RULES`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/rules.ts#L130-L134) — "The GitHub credential you hold"

A fresh worker run **that has a repository** — the conditional is
[`worker.ts#L159`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L159). A
scratch-directory run with no checkout is not told about a token it will not reach for.

---

## 3. Per-role rules

### [`WORKER_RULES`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/rules.ts#L155-L157)

Every worker turn, fresh or resumed, as the last section of the prompt under
`## Before you finish`. It is the positive form of the rule the stop hook enforces in §5, and its
second paragraph names the handoff file the orchestrator reads back off disk (§4).

### [`MANAGER_RULES`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/rules.ts#L171-L236)

Every fresh manager turn, as the first section of the prompt. Not repeated on a resumed turn.
The longest single piece of prompt text in the system; the sections inside it are its own
headings — what the manager can do, its shell and what it is for, how it moves and removes cards,
how it files work, how it steers running work, how it is recorded, how a turn ends, how it
answers.

The tool names spelled inside it are asserted against the real tool table in
[`manager.test.ts`](https://github.com/Mark-Life/agent-task-manager/blob/main/packages/prompts/src/manager.test.ts),
so a renamed tool is a failing test rather than a manager calling something that does not exist.

---

## 4. Injected at dispatch time

Everything in this section is composed per run out of database rows and run-time paths. The text
is short; the code that produces it is the entry.

### Worker

| Link | Who and when |
|------|--------------|
| [Title, brief, acceptance](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L151-L153) | Worker, fresh turn. The card's own text, as the person or the manager wrote it. `# <title>` is the prompt's first line. |
| [`projectSection`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L122-L129) | Worker, fresh turn, when the task belongs to a project: one line of `name — description`. |
| [`placementSection`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/render.ts#L79-L102) | Both roles, fresh turn, as `## Where you are working`. The repo URL and branch, the writable artifacts directory, the read-only reference directories — and, for a run whose scratch directory *is* its writable one, a different sentence saying so. The policy about those paths is in `ARTIFACT_RULES`; this section only says which directory is which. |
| [`renderThread` / `renderComment`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L109-L119) | Worker, both modes. The comments the session has not read, oldest first. |
| [`commentLabelOf`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L84-L106) | The attribution line above each comment — `the human said:`, `the manager agent said:`, `the orchestrator said:`, `you said:`, `another session on this task (abcd1234) said:`. This is what makes a multi-session review loop readable. |
| [`KIND_NOTE`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L62-L66) | Appended to that label: ` (auto-appended final message)` or ` (that run crashed)`. |
| [Resumed heading](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/worker.ts#L182-L189) | Worker, resumed turn: the `— continued` line, the sentence about its own history, and `Nothing was added. Pick up where you stopped.` when the thread is empty. |

### Manager

| Link | Who and when |
|------|--------------|
| [`speakerLabelOf`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/manager.ts#L64-L76) | Manager, both modes. `Person:` / `You:`, with the intake kind named where it changes how the words should be read — `(forwarded from …)`, `(voice note, transcribed)`, `(several messages, sent together — answer them as one)`. |
| [`SPEAKER`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/manager.ts#L45-L48) | The two speaker names those labels are built from. |
| [`ANSWER_INSTRUCTION`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/manager.ts#L108-L109) | Manager, both modes, whenever at least one message is unread: says which message is the one waiting for a reply. |
| [`FRESH_HISTORY_MESSAGES`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/manager.ts#L42) | Not text, but it decides how much of a thread a first manager turn is shown: the last 40 rows. |
| [Resumed heading](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/prompts/src/manager.ts#L138-L143) | Manager, resumed turn, including `Nothing new arrived.` |

### Written by other components, read later as prompt text

These are not prompts when they are written — they are comments on a card, or a header inside a
stored chat message. They become prompt text on the next dispatch, because the thread is what the
next session is shown.

| Link | Who and when |
|------|--------------|
| [`composePieceLabel` / `composedBody`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/apps/bot/src/telegram/compose.ts#L240-L263) | The bot, when a person batches several messages: `[message 2 of 3 · voice note, transcribed]` headers written *into* the stored body. The manager reads them on its next turn. |
| [`errorCommentBody`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/terminal.ts#L142-L145) | The orchestrator, when a run fails: `**Run failed — <class>**` and the sanitized message, or [`UNSTATED_FAILURE`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/terminal.ts#L91) when the run said nothing. Posted as a `run_error` comment, so a later session reads it labelled `(that run crashed)`. |
| [`fallbackCommentBody`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/terminal.ts#L148-L152) and [`TRUNCATION_NOTE`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/terminal.ts#L86-L88) | The orchestrator, when a run ended without commenting: the final assistant message, clipped to 16 KiB, with the cut stated. Read later labelled `(auto-appended final message)`. |
| [`handoffNote` / `handoffCommentBody`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/terminal.ts#L161-L168) | The orchestrator, when a run lost the board and wrote `handoff.md` instead: `_Attached from …— this run could not post it itself._` above the file's contents. The file is found by [`readHandoff`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/handoff.ts#L70-L96), which reads exactly the filename `WORKER_RULES` and `NO_COMMENT_REFUSAL` both name. |

---

## 5. Mid-turn: the stop hook

The one piece of text that arrives *during* a turn rather than at the start of it.

File: [`packages/harness/src/stop-hook.ts`](https://github.com/Mark-Life/agent-task-manager/blob/main/packages/harness/src/stop-hook.ts).

| Link | Who and when |
|------|--------------|
| [`NO_COMMENT_REFUSAL`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/stop-hook.ts#L240) | **A worker, mid-turn, at most once.** When the agent tries to end a turn and the run's comment marker does not exist, this string is returned as the hook's `reason` and the harness feeds it to the model as its next prompt. Its wording deliberately tracks `WORKER_RULES`. |
| [`decideStop`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/stop-hook.ts#L265-L279) | The rule that chooses between allowing and refusing. Fail-open at every step, and capped at one retry through `stop_hook_active`. |
| [`commentRuleApplies`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/stop-hook.ts#L107-L109) | **Why a manager never sees the refusal.** A turn with no `taskId` has nothing to comment on, so the hook is not registered at all — the entrypoint asks this before it names the command, at [`entrypoint.ts#L512-L519`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/entrypoint.ts#L509-L519), and clears the variable when the answer is no. |
| [`scripts/stop-hook.ts`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/scripts/stop-hook.ts#L42-L51) | The process both harnesses invoke: reads one JSON payload on stdin, writes one JSON response on stdout. Every failure allows the turn to end. |
| [`stopHookSettings`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/claude-settings.ts#L141-L152) | How the hook is registered on Claude: a `Stop` entry in the settings object, only when `ATM_STOP_HOOK_COMMAND` names a command. |
| [`codexHooksFile`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/codex-hooks.ts#L75-L96) | How it is registered on Codex: a `hooks.json` written into the run's `CODEX_HOME`, plus the trust-bypass flag in [`HEADLESS_FLAGS`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/codex.ts#L91-L95). Its `description` field is metadata for the CLI's own hook listing, not text the model reads. |
| [`containerStopHookCommand`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/turn-spec.ts#L134-L135) | The command line that gets registered: the same bundled entrypoint, in its other mode. |

---

## 6. What the provider adds around the prompt

None of this text lives in this repository; what lives here is the decision to load it. It lands
in the context of every run before the built prompt does.

| Link | What it pulls in |
|------|------------------|
| [`systemPrompt: { preset: "claude_code" }`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/claude.ts#L323) | **The vendor's own Claude Code system prompt**, shipped inside `@anthropic-ai/claude-agent-sdk` and its CLI. The single largest block of text a run sees, and the only one not authored here. |
| [`CLAUDE_SETTING_SOURCES`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/claude-settings.ts#L59-L63) | `user`, `project`, `local`. **`project` is what makes the CLI read the checked-out repository's `CLAUDE.md`** (§7); `user` resolves inside the run's own agent home (§8). Set explicitly rather than defaulted, so the repo's instructions are loaded on purpose. |
| [`DEFAULT_CLAUDE_SETTINGS`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/claude-settings.ts#L113-L119) | `disableBundledSkills: true` — the skills shipped with the CLI are **not** in a run's context. The flag leaves plugins, `.claude/skills/` and `.claude/commands/` alone, so the repository's own skills and the operator's shared directory still load. `disableClaudeAiConnectors` and `disableRemoteControl` keep the logged-in account's connectors out. |
| [`DENIED_TOOLS`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/claude-settings.ts#L84-L96) | Eleven tools denied on every run. Each denied tool is also a tool definition the run does not pay context for — `NotebookEdit` is on the list for that reason alone. |
| [`CLAUDE_SETTINGS_JSON`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/claude-settings.ts#L193-L198) | The operator's escape hatch: a JSON overlay merged over the defaults above. An install that sets it changes what every run is loaded with, so it belongs in any audit of what an agent sees. |
| [`codexArgs`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/codex.ts#L145-L162) | The Codex side. Codex reads `AGENTS.md` out of the working directory itself, with no setting to enable — so on that provider §7's `AGENTS.md` is the repo-level instruction that loads, and `.claude/CLAUDE.md` is not. The prompt travels on stdin, never in argv. |

---

## 7. Repo-level instructions inside the checkout

These reach a worker because they are files in the repository it checked out. **A worker on some
other repository sees that repository's equivalents, not these.** They are listed because this
repo is its own dogfood: a worker run on `agent-task-manager` reads exactly these.

| Link | Who and when |
|------|--------------|
| [`AGENTS.md`](https://github.com/Mark-Life/agent-task-manager/blob/main/AGENTS.md) | 28 lines: the TypeScript rules, the Effect typechecking gate, where to read stack decisions. Loaded by Codex natively, and by Claude through the `CLAUDE.md` import below. |
| [`.claude/CLAUDE.md`](https://github.com/Mark-Life/agent-task-manager/blob/main/.claude/CLAUDE.md) | One line — `@../AGENTS.md`. It exists so the two providers read one file. This is the file the `project` setting source finds. |
| [`.claude/settings.json`](https://github.com/Mark-Life/agent-task-manager/blob/main/.claude/settings.json) | Project settings, also loaded by the `project` source. It registers a `Stop` hook that runs `bun x ultracite fix` and `bun x ultracite check` — not prompt text, but its output reaches the agent as hook feedback, so a failing check is something the model reads. |
| [`.agents/skills/`](https://github.com/Mark-Life/agent-task-manager/tree/main/.agents/skills) | Six skills, the real files: [`effect`](https://github.com/Mark-Life/agent-task-manager/blob/main/.agents/skills/effect/SKILL.md), [`effect-client-wrapper`](https://github.com/Mark-Life/agent-task-manager/blob/main/.agents/skills/effect-client-wrapper/SKILL.md), [`observability`](https://github.com/Mark-Life/agent-task-manager/blob/main/.agents/skills/observability/SKILL.md), [`quality-code`](https://github.com/Mark-Life/agent-task-manager/blob/main/.agents/skills/quality-code/SKILL.md), [`shadcn`](https://github.com/Mark-Life/agent-task-manager/blob/main/.agents/skills/shadcn/SKILL.md), [`ultracite`](https://github.com/Mark-Life/agent-task-manager/blob/main/.agents/skills/ultracite/SKILL.md). A skill's `description` frontmatter is in every run's context; its body is read only when the model invokes it. |
| [`.claude/skills/`](https://github.com/Mark-Life/agent-task-manager/tree/main/.claude/skills) | Six symlinks into the directory above — the path the CLI looks in. Same six files, one copy. |
| [`skills-lock.json`](https://github.com/Mark-Life/agent-task-manager/blob/main/skills-lock.json) | Where three of those six came from upstream (`effect`, `observability`, `quality-code`) and the hash each was vendored at. The provenance record for text an agent reads. |

---

## 8. What the sandbox image and the mounts contribute

**The image contributes no prompt text.** [`docker/base.Dockerfile`](https://github.com/Mark-Life/agent-task-manager/blob/main/docker/base.Dockerfile)
installs Node, Bun, git, `gh` and the two agent CLIs, and sets `git config --system safe.directory`.
It writes no `CLAUDE.md`, no `AGENTS.md`, no settings file and no MOTD. What it does contribute is
the *path* the stop-hook command and the CLI are found at, which is why both are read off the
environment rather than baked into a constant.

The mounts, however, decide what other text a run can be given:

| Link | Who and when |
|------|--------------|
| [`CONTAINER_AGENT_HOME_DIR`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/sandbox/src/mounts.ts#L205) and [`AGENT_HOME_ENV_VAR`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/paths.ts#L48-L51) | The provider's config directory is a host directory mounted at `/agent-home` and pointed at through `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. **The `user` setting source resolves inside it**, so anything an operator left there — a user-level `CLAUDE.md`, a user `settings.json` — is loaded into every run. It is seeded from a logged-in account by [`scripts/agent-home-login.ts`](https://github.com/Mark-Life/agent-task-manager/blob/main/scripts/agent-home-login.ts) and is not in this repository; [`.docs/agent-homes.md`](./agent-homes.md) describes it. |
| [`CONTAINER_SKILLS_DIR`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/sandbox/src/mounts.ts#L205-L214) and [`skillsMounts`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/sandbox/src/mounts.ts#L316-L327) | The operator's own skills directory (`ATM_SKILLS_DIR`) mounted read-only at `/agent-home/skills` — the one bind inside another bind, because a provider reads personal skills from a fixed name under its config directory. Every run of both roles is given whatever is in it. Read-only, so no run can edit the instructions later runs get. |
| [`mounts.ts` header](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/sandbox/src/mounts.ts#L1-L106) | The full argument for the mount set, including which directories are read-only and why. |

---

## 9. The MCP layer

Tool names and descriptions are context every turn pays for, and they are read by the model
exactly like prompt text.

### The board server (`atm`)

Nineteen tools, one per gateway operation, in
[`packages/agent-tools/src/tools.ts`](https://github.com/Mark-Life/agent-task-manager/blob/main/packages/agent-tools/src/tools.ts).
**Both roles are handed the same table** — a worker's reach is narrowed by its token's binding to
one task, not by a shorter tool list. Each entry below opens on that tool's description and input
schema. The input JSON Schema an agent reads is generated from the API's own request schema, so
those field names and doc comments are agent-visible too.

| Tool | Description |
|------|-------------|
| `projects_list` | [tools.ts#L88-L95](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L88-L95) |
| `projects_create` | [#L97-L109](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L97-L109) |
| `tasks_list` | [#L111-L135](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L111-L135) |
| `tasks_get` | [#L137-L149](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L137-L149) |
| `tasks_create` | [#L151-L159](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L151-L159) |
| `tasks_edit` | [#L161-L177](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L161-L177) |
| `tasks_move` | [#L179-L201](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L179-L201) |
| `tasks_delete` | [#L203-L214](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L203-L214) |
| `comments_list` | [#L216-L227](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L216-L227) |
| `comments_add` | [#L229-L241](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L229-L241) |
| `runs_status` | [#L243-L259](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L243-L259) |
| `runs_stop` | [#L261-L273](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L261-L273) |
| `runs_rerun` | [#L275-L287](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L275-L287) |
| `artifacts_list` | [#L289-L303](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L289-L303) |
| `artifacts_read` | [#L305-L327](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L305-L327) |
| `threads_list` | [#L329-L340](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L329-L340) |
| `threads_get` | [#L342-L353](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L342-L353) |
| `threads_messages` | [#L355-L370](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L355-L370) |
| `threads_runs` | [#L371-L378](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L371-L378) |

Supporting links: the [module header](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L1-L29)
explains why one table serves both roles; [`AGENT_TOOLS`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/tools.ts#L392-L411)
is the ordered list; [`server.ts#L38-L47`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/server.ts#L40-L45)
is what a `tools/list` response is built from; [`AGENT_SERVER_NAME`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/agent-tools/src/provider-config.ts#L37-L41)
is why every one of them is called `mcp__atm__<name>` in a transcript. The server advertises no
MCP `instructions` string — the tool descriptions are all of it.

**How it reaches a run**, which is the assembly question again:
[`run.ts#L553-L583`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/run.ts#L553-L583)
copies the bundle, mints a rolling token, and either writes
[`mcp-servers.json`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/orchestrator/src/agent-token.ts#L216-L268)
into the run mount for a container to read, or hands the same map to a host-side turn directly.
An install with no gateway configured runs with no board tools at all.

### Executor (`executor`)

[`packages/harness/src/executor-mcp.ts`](https://github.com/Mark-Life/agent-task-manager/blob/8d71b617bf3e915d4a987895817d6c39989bb48b/packages/harness/src/executor-mcp.ts#L1-L36).
A hosted endpoint reached over HTTP, wired for both providers when `EXECUTOR_MCP_URL` and
`EXECUTOR_MCP_KEY` are both set. **Its tool names and descriptions are authored by Executor, not
here** — this repo contributes only the `mcp__executor__` prefix and the credential handling. Both
roles get it when it is configured; an unconfigured install gets no Executor tools, which is a
smaller agent and not a broken one.

---

## 10. Deliberately not on this list

Checked and excluded, so a later reader does not re-derive them:

- **Operator-facing text** — the boot banners (`apps/loop/src/banner.ts`, `apps/bot/src/banner.ts`),
  `/status` replies, CLI check scripts. Printed to a terminal or a chat, never into a model's context.
- **API and OpenAPI descriptions** — except where a request schema is an MCP tool's input, in which
  case it is covered by §9.
- **The dashboard and the Telegram views** — they render what an agent produced; they add nothing to
  what one is given.
- **There are no subagent definitions** (`.claude/agents/`) and no slash commands (`.claude/commands/`)
  in this repository, so nothing is contributed from either.
- **No prompt text is stored in the database or read off an operator's disk at dispatch.** Task briefs,
  comments and chat messages are content written by people and agents; the rules are code.

### Re-deriving this list

Every prompt constant in the repo is a template literal assigned to a `SCREAMING_CASE` export, so:

```bash
grep -rnE 'const [A-Z_]+ = .?`' --include='*.ts' packages apps | grep -v '\.test\.'
```

returns the constants in §2, §3 and §5, plus a handful of non-prompt strings (a cookie name, a git
credential helper, two MCP prefixes). Everything else on this page is assembled rather than
declared, and §1 is where the assembly is.
