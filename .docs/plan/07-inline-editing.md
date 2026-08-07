# Notion-style inline editing for tasks

One task body that shows data and accepts edits in the same rendering. No form mode, no edit
dialog. Click a value, change it, it saves.

## Current

- Create: `NewTask` button -> `TaskFormDialog` (modal) -> open overlay.
- Title: read-only text; pencil opens the dialog.
- Brief/acceptance/metadata: pencil swaps section into textarea mode with Save/Cancel.
- Project, PR URL, repo URL, sandbox image: only editable inside the dialog; invisible when unset.

## Target

- Create: click **New task** -> a draft panel opens (client-side only). The first committed
  field files the task; edits during the request follow as one patch; closing untouched saves
  nothing. No dialog.
- Every field edits in place; commit on blur / Enter, Esc reverts (textareas: Cmd+Enter commits).
  - Title: styled input in the header; empty reverts (title is non-empty).
  - Brief / acceptance: click text -> textarea; unset renders `Add acceptance…`.
  - Properties: Notion-style label/value rows -> Status (existing select), Project (select),
    Pull request, Repository, Sandbox image (click-to-edit; `Empty` when null).
  - Metadata: keep raw-JSON editing with parse validation, same click-to-edit pattern.
- Header keeps verbs (PR link, delete, close); actions row keeps verbs (stop, rerun, comment).
  Status select moves into the property rows; project name leaves the meta line (now a property).
- Overlay and `/tasks/<id>` page share `TaskDetailView`: both get the new body for free.

## Changes

1. `features/task/inline.tsx` (new): `InlineText`, `InlineArea`, `PropertyRow` primitives.
   Committed value comes from props; local draft only while editing; patch fires on commit;
   optional `validate` vetoes an invalid commit (metadata JSON).
2. `features/task/properties.tsx` (new): the property rows.
3. `features/task/header.tsx`: title -> `InlineText`; drop pencil + dialog.
4. `features/task/brief.tsx`: per-field click-to-edit; drop section-wide edit mode.
5. `features/task/status-select.tsx`: absorb `STATUS_LABELS`.
6. `features/task/actions.tsx`: drop `StatusSelect`; keep stop/rerun/comment.
7. `features/task/draft.tsx` (new): the client-side draft sheet; files on first commit.
8. Delete `features/task/task-form.tsx` and `features/task/task-fields.tsx`.

## Notes

- Human transitions reach every column from any column, so `StatusSelect` covers what the
  create-time column picker did; `creatableStatuses` usage goes away.
- Validation: typecheck + `ultracite fix`; repo has no dashboard component tests.
