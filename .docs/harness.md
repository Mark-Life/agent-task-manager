# Agent harness (`bun run harness:check`)

`packages/harness` turns a prompt and a workspace into a stream of normalized events. Claude
and Codex are behind one registry keyed by the `provider` value stored on an agent session, so
the orchestrator selects a harness from a row and never imports either SDK. Capability flags
(`cost`, `hooks`, `resume`, `rateLimitSignal`, `reasoning`, `subagents`) answer what a provider
can be relied on to do before a run starts. The package never imports `packages/db`.

The provider is pointed at the mounted agent home through `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
(see [agent homes](./agent-homes.md)), so every session's transcript lands in one tree and the reader finds this run's by
its provider session id — never by "the newest file", which under a shared tree is a
neighbour's conversation. A run that ended before naming a session has no transcript rather
than the wrong one. One invocation leaves exactly one `atm.turn` row in the ledger, on every
exit path including an interrupt.

A stop hook (`packages/harness/scripts/stop-hook.ts`) refuses a turn that tries to end without
having posted a comment, capped at one retry; the refusal is fed back to the model as its next
prompt. The sandbox names the executable through `ATM_STOP_HOOK_COMMAND` and the run's comment
marker through `ATM_COMMENT_MARKER`.

**It is only registered on a turn that has a task.** A manager turn answers in a conversation
and has no card to comment on, so the entrypoint asks `commentRuleApplies(spec.identity)` before
it names the command — and clears the variable when the answer is no, since the image may carry
one. A manager handed this hook is refused by a rule about a card it does not have, and spends
the turn it was given telling the person so.

```bash
bun run harness:check                        # no model call: agent homes, layout, registry, hook
bun run harness:check --live                 # one real turn per provider, transcript, rows
bun run harness:check --live --provider codex  # just the one harness
```

