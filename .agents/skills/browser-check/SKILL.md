---
name: browser-check
description: How to actually look at this repository's dashboard from inside a run — screenshot a surface with no dev server, no gateway and no Postgres, and the four traps that make a correct screenshot come back wrong. Use when a change touches `apps/dashboard` or `packages/ui`, or when a claim is about something rendered.
---

# Looking at the dashboard

The container has a headless Chromium at `/usr/bin/chromium` and `agent-browser`
on PATH. This file is the part that is about *this* repository: how to get a
real surface in front of it, and the traps that produce a screenshot which looks
like a bug and is not.

## The fast path: no dev server, no gateway, no database

A dashboard surface renders from a static file. Do not stand up Postgres and the
gateway to look at a component.

1. `bun run dashboard:build` once, to get `apps/dashboard/dist/assets/*.css`.
2. `renderToStaticMarkup` the real feature component inside a
   `QueryClientProvider` whose cache you pre-seeded:
   `client.setQueryData(keys.X(id), fixture)`. An infinite query takes
   `{ pages: [page], pageParams: [0] }`.
3. Inline that CSS into the HTML, write the file, and `page.goto('file://…')`.

`TaskBrief`, `TaskMessages` and `Transcript` have all been photographed this
way, base-ui `Collapsible` and `Button` included.

When you need interaction rather than a picture — a tap, a keystroke, a hover
that must *not* fire — run the app: `cd apps/dashboard && bun run dev --port
5199`, and reach it on `localhost`, not `127.0.0.1`, because Vite binds v6 here.

## The four traps

Each of these produces a wrong picture rather than an error, which is why they
are worth reading before rather than debugging after.

- **Seeded timestamps must be `DateTime.makeUnsafe(iso)`, not a JS `Date`.** A
  `Date` renders every relative time as `NaNd`.
- **Message rows carry `content-visibility:auto`.** Anything below the viewport
  screenshots blank even with `fullPage`. Set the viewport tall enough to cover
  the whole page instead.
- **Screenshot at `deviceScaleFactor: 1` and no more than 2000px.** Above that
  the Read tool refuses the image, so you cannot look at what you captured.
- **A touch context is not a small desktop one.** A hover-only control is
  reachable with a mouse at 390px wide. Use a touch context and tap, so no hover
  event is ever generated — that is the whole bug class this repository has
  already shipped twice.

## What the repository does not have

`apps/dashboard` has no in-repo DOM harness: no `happy-dom`, no `jsdom`, no
`bunfig` preload. Its committed component tests use `renderToStaticMarkup`, and
that only works for trees with no base-ui component in them — base-ui reads
`window` *while it renders*, so `Button`, `Select` and anything built on them
throw `ReferenceError: window is not defined` under `bun test`.
`features/usage/meters.test.tsx` is the pattern that works.

So a keystroke or a layout claim has no regression test to add itself to today.
Screenshot it, put the shots and the script that made them in the task's
artifacts directory with a line saying how to re-run them, and say in the pull
request which claims are covered by a picture and which by a test.

## Saying what you saw

Name the viewport and what you did, not that you "verified it": *"390x844 touch
context, tapped rather than clicked so no hover event was generated"* is a claim
a reviewer can check. If one acceptance criterion went unlooked-at, say which
one and why — a browser that was available and not used is worse than one that
was not there.
