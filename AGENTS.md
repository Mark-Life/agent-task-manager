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

## Stack
When making decisions on new stack, or libs to add, read stack options from the template author at `.docs/stack.md`.
