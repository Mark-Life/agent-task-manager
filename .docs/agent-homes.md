# Agent homes (one-time setup, before any run)

There is **one system-owned directory per provider** on the host, and every container mounts it
read-write at `/agent-home`. It is not under `DATA_ROOT`, it is never copied, and it outlives
every run.

That is not tidiness. Both CLIs refresh their subscription token in place, so a private copy
per run means the refresh is discarded with the container while the source goes permanently
stale — which is a failure this repo has already had with Codex. One shared directory, written
by whichever container refreshed last, is the same arrangement several interactive CLI sessions
on one laptop already rely on. Claude locks its credential writes cross-process
(`<dir>/.storage-write`), which is what makes concurrent containers safe there.

**Nothing on the run path creates or seeds these directories.** An auto-created empty home is a
container that boots and reports an auth error nobody can tell from an expired subscription, so
a missing one fails the dispatch by name instead.

```bash
bun run agent-home:login                     # creates both at 0700, says what each still needs
CLAUDE_CONFIG_DIR=~/.claude-task-management claude    # then /login
CODEX_HOME=~/.codex-task-management codex login
bun run harness:check                        # tells you whether that worked
```

On macOS Claude stores its tokens in the login keychain rather than in the directory, and it
names the keychain item after the config directory — so `/login` with `CLAUDE_CONFIG_DIR` set
leaves the directory empty. `bun run agent-home:login claude` covers that: it exports the existing
keychain item to `<dir>/.credentials.json` at `0600`, once. It refuses to overwrite an existing
file, because that file may be a token a container refreshed after you last logged in. The
container is Linux, has no keychain, and writes the plaintext file itself from then on.

**Ownership.** Create the directory as yourself, at `0700` — which `mkdir` gives it. A bind
mount does no id translation, and every container this repo starts runs as
`--user=<your uid>:<your gid>`, so a write from inside lands as you on a directory only you can
read. Nothing needs chowning and nothing needs to be uid 1000; `DEFAULT_USER = "1000:1000"` in
`packages/sandbox/src/hardening.ts` is only the fallback for a runtime with no `getuid`.
`sandbox:check` proves this rather than asserting it: it writes a file from inside the container
into a throwaway agent home and checks the owner on the host afterwards.

**What a run can see, stated plainly.** Every worker run and every conversation writes its
transcript into the one tree, so a run can read every other run's conversation. That is a
capability the manager needs and a leak for a worker, accepted for v1. Nothing prunes
`projects/-workspace/` either — that tree grows one JSONL per run forever.

**Sharing your own skills.** Set `ATM_SKILLS_DIR` to the directory you keep your skills in — on
this host `~/.agents/skills` — and every container gets it read-only at `/agent-home/skills`,
which is where Claude looks for personal skills once `CLAUDE_CONFIG_DIR` points at the agent
home. It is a mount and not a copy: edit a skill and the next turn has it. Create the mountpoint
once, `mkdir -p <agent home>/skills`, so the daemon does not create it as root inside a
directory that is yours.

Override either path with `ATM_AGENT_HOME_DIR_CLAUDE` / `ATM_AGENT_HOME_DIR_CODEX`. They are
deliberately not spelled `CLAUDE_CONFIG_DIR` / `CODEX_HOME`: those two relocate the config
directory of whatever process exports them, including your own shell's.

