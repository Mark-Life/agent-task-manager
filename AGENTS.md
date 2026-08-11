## TypeScript
when coding in typescript, always load quality-code skill: `.agents/skills/quality-code/SKILL.md`

The compiler is TypeScript 7 (the native Go port), pinned once in the root `package.json`. Do not
add a per-workspace `typescript` pin. Do not reintroduce `baseUrl`, `downlevelIteration`,
`target: es5`, `moduleResolution: node10`, or `module: umd` — 7 removed them, and `esModuleInterop`
/ `allowSyntheticDefaultImports` can no longer be disabled. `strict` is the default; do not
re-declare `strictNullChecks`.

## Typechecking Effect code
`bun run typecheck` is one pass and two gates. The binary behind `tsc` is `@effect/tsgo`, which
carries the Effect language service, so `floatingEffect`, `missingEffectContext`,
`missingLayerContext`, `missingStarInYieldEffectGen` and the rest are reported alongside ordinary
type errors. Errors and warnings fail; suggestions print and do not.

- Run `bun run typecheck` before calling Effect work done. `bun run check` (biome) does not see
  these rules, and neither does `bun test`.
- Fix what a diagnostic reports. Do not silence one by turning its severity down in
  `packages/typescript-config/base.json` — that file is the repo-wide gate, and the rules already
  held at `suggestion` are listed there with the cleanup each is waiting on. For a genuinely
  intentional single case, use an `@effect-diagnostics-next-line` directive at the site, where a
  reviewer can see the justification.
- Diagnostics gone quiet? `prepare` runs `effect-tsgo patch` on every `bun install`; run
  `bunx effect-tsgo patch --typescript --no-oxlint` if it was skipped. After changing plugin
  options, delete `**/*.tsbuildinfo` — `incremental` caches the old severities.

## Changes you can see
When a change touches `apps/dashboard` or `packages/ui`, load the browser-check skill:
`.agents/skills/browser-check/SKILL.md`. The container has a real headless Chromium, so a layout,
a colour or a control that has to be reachable is something to look at rather than argue from the
components. The skill covers how to render a surface with no dev server, gateway or database, and
the four traps that make a correct screenshot come back wrong.

## Tests that touch the database
The repository tests write real rows, so they get a database and a workspace of their own. Both
walls already exist; keep them.

- Never find a workspace with `workspaces.list()[0]`. That is how four fixture cards ended up on
  the production board. Call `ensureFixtureWorkspace({ suite })` from `@workspace/db/testing` —
  one workspace per suite, created on first use.
- A card a test files should carry `metadata: FIXTURE_METADATA`, which keeps it out of every
  column listing and so out of the dispatch queue. The exception is a test whose subject *is* a
  column read — `dispatch.test.ts` is the one — and it says so where it seeds.
- `DATABASE_URL` is redirected to `<database>_test` by the preload
  (`@workspace/db/testing/root-env`), which every `bunfig.toml` in the repo loads. Do not add a
  fifth copy of that file, and do not read `DATABASE_URL` in a test to decide where to write.
- `bun run test` runs `bun run db:test` first, which creates and migrates that database.

## Stack
When making decisions on new stack, or libs to add, read stack options from the template author at `.docs/stack.md`.
