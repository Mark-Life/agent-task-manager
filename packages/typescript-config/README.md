# `@workspace/typescript-config`

Shared TypeScript configuration for the workspace. Targets **TypeScript 7**.

| Config | Extend it from |
| --- | --- |
| `base.json` | plain TypeScript packages |
| `nextjs.json` | Next.js apps |
| `react-library.json` | React component libraries |

TypeScript is pinned once, in the root `package.json`. No workspace pins its own, and
`scripts/upgrade.ts` deliberately does not re-add per-workspace pins.

## Notes for TypeScript 7

- `strict` is on. It is now the compiler default, but stays explicit here so the intent survives a
  future default change. Individual packages should not re-declare `strictNullChecks` — `strict`
  covers it, and the overrides that used to sit in all eighteen workspace configs were dead weight.
- `esModuleInterop` and `allowSyntheticDefaultImports` are deliberately absent: TypeScript 7 removed
  the ability to disable them, so setting them is a no-op and setting them to `false` is a hard
  error.
- Options removed in TypeScript 7 that must not be reintroduced: `baseUrl` (use `paths`, resolved
  relative to the config file), `downlevelIteration`, `target: es5`, `moduleResolution:
  node10`/`classic`, and `module: amd`/`umd`/`systemjs`/`none`.
- Two widely repeated claims about 7 are false, and were checked against the installed compiler
  rather than release notes: `types` does **not** default to `[]`, and the default-on
  `noUncheckedSideEffectImports` does **not** break CSS imports.

## The Effect language service

`base.json` loads `@effect/language-service` as a compiler plugin. The implementation is
[`@effect/tsgo`](https://github.com/Effect-TS/tsgo), a superset of Microsoft's `tsgo` that embeds a
pinned TypeScript-Go plus the Effect diagnostics — use it *instead of* `tsgo`, never alongside, or
every diagnostic is reported twice.

Diagnostics run during the `tsc` typecheck phase rather than through a separate
`effect-tsgo diagnostics` command, so the program is checked once and `bun run typecheck` stays the
single gate.

Three things are worth knowing before editing this file.

**The plugin entry only carries options.** The diagnostics are compiled into the binary and run
whether or not a `plugins` entry exists; removing the entry does not turn them off, it drops the
severity choices and reverts everything to rule defaults.

**`plugins` is not merged by `extends`.** A config that declares its own `plugins` array replaces
this one wholesale — which is why `nextjs.json` has to restate anything it wants, and why it
deliberately does not (`apps/web` has no `effect` dependency).

**Options are cached.** With `incremental` on, a `.tsbuildinfo` written before a change here keeps
serving the old severities, silently. Delete `**/*.tsbuildinfo` after editing plugin options, or
you will conclude the option does not work.

### Which severities fail the build

Errors and warnings, stated explicitly in `base.json` rather than left to defaults. Suggestions
print and are ignored — which is what makes `suggestion` a usable parking place: a rule held there
still reports every occurrence on every typecheck, it just does not block.

Rules currently held below their default, each waiting on a cleanup rather than dismissed:

| Rule | Default | Held at | Waiting on |
| --- | --- | --- | --- |
| `multipleEffectProvide` | warning | suggestion | 7 sites, all test setup. Each is a dependency-ordered `Effect.provide` chain; collapsing one is a rewrite into `Layer.provide` composition decided per site, not a merge. |
| `globalErrorInEffectCatch` | warning | suggestion | 11 sites with `globalErrorInEffectFailure`. Deciding which failures deserve tagged error types and threading those through their callers' error channels. |
| `globalErrorInEffectFailure` | warning | suggestion | as above. |

Anything not listed runs at the rule's own default, so a new violation of any other rule fails the
build. Per-path exceptions, if they are ever needed, go in the plugin's `overrides` array rather
than by turning a rule down globally.
