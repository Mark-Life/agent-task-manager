/**
 * The page the viewer draws into, and the stylesheet that makes it dark.
 *
 * `render.ts` writes a shell whose only contract is a `<body>`; everything a
 * person sees is built here at load, so the viewer can be dropped into any
 * host page and still come up with the same top bar, canvas and detail panel.
 */

const CSS = `
:root {
  --bg: #0b0e13;
  --bg-2: #11151c;
  --bg-3: #161b24;
  --line: #222a36;
  --fg: #e8ecf2;
  --muted: #8a94a6;
  --accent: #7dd3fc;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.5 var(--sans);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
.mono { font-family: var(--mono); }
.muted { color: var(--muted); }
.spacer { flex: 1; }

#bar {
  border-bottom: 1px solid var(--line);
  background: var(--bg-2);
  flex: none;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  min-height: 44px;
}
.bar-row-2 {
  border-top: 1px solid var(--line);
  min-height: 38px;
  padding: 6px 12px;
}
#brand {
  font-family: var(--mono);
  font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--accent);
  text-transform: uppercase;
  font-size: 12px;
  padding-right: 4px;
}

.seg { display: flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
.seg-btn {
  background: transparent;
  border: 0;
  border-right: 1px solid var(--line);
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  padding: 5px 13px;
}
.seg-btn:last-child { border-right: 0; }
.seg-btn:hover { color: var(--fg); background: var(--bg-3); }
.seg-btn.on { background: #1d2735; color: var(--fg); }

#search {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--fg);
  font: 12px var(--mono);
  padding: 6px 10px;
  width: 230px;
}
#search:focus { border-color: var(--accent); outline: none; }

button.link {
  background: none;
  border: 0;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 2px 6px;
}

.chip, .menu > button, .switch {
  align-items: center;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  font: 11px/1 var(--mono);
  gap: 6px;
  padding: 5px 10px;
  white-space: nowrap;
}
.chip:hover { color: var(--fg); }
.chip.on { color: var(--fg); background: var(--bg-3); border-color: #38424f; }
/* Disabled, not damaged: the label stays legible against the chip and only the
   border and the colour dot recede. A blanket opacity took the text to 2.4:1. */
.chip.na { color: #7b8494; border-color: #1a212b; }
.chip.na .dot { opacity: 0.35; }
.chip.static { cursor: default; }
.switch.off { color: #7b8494; cursor: default; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
#focus-chip { color: var(--fg); border-color: var(--accent); }

.menu { position: relative; }
.menu-body {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
  max-height: 60vh;
  overflow: auto;
  padding: 6px;
  position: absolute;
  top: 30px;
  left: 0;
  width: 260px;
  z-index: 20;
}
.menu-actions {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 4px;
  margin-bottom: 4px;
}
.menu-item {
  align-items: center;
  border-radius: 5px;
  cursor: pointer;
  display: flex;
  font: 11px var(--mono);
  gap: 8px;
  padding: 4px 6px;
}
.menu-item:hover { background: var(--bg-3); }
input[type="checkbox"] { accent-color: var(--accent); }
.switch { font-family: var(--sans); font-size: 12px; }

#search-list { width: 420px; }
.hit {
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--fg);
  cursor: pointer;
  display: block;
  font: 11px var(--mono);
  padding: 5px 7px;
  text-align: left;
  width: 100%;
}
.hit:hover, .hit.on { background: var(--bg-3); }
.hit.on { outline: 1px solid var(--accent); }
.hit-top { align-items: baseline; display: flex; gap: 7px; }
.hit-kind { flex: none; font-size: 10px; }
.hit-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-where { color: var(--muted); font-size: 10px; margin-top: 1px; }
.hit-off { color: #7b8494; font-size: 10px; }

#body { display: flex; flex: 1; min-height: 0; position: relative; }
#cy { flex: 1; min-width: 0; background: var(--bg); }
#hint {
  position: absolute;
  left: 34%;
  top: 46%;
  transform: translate(-50%, 0);
  color: var(--muted);
  font-size: 13px;
  max-width: 380px;
  text-align: center;
  pointer-events: none;
}

#panel {
  background: var(--bg-2);
  border-left: 1px solid var(--line);
  flex: none;
  overflow-y: auto;
  padding: 14px 14px 40px;
  width: 372px;
}
.empty { color: var(--muted); margin: 6px 2px; }
.panel-head { align-items: center; display: flex; gap: 8px; margin-bottom: 10px; }
.kind-chip {
  border: 1px solid;
  border-radius: 999px;
  font: 10px/1 var(--mono);
  letter-spacing: 0.08em;
  padding: 4px 8px;
  text-transform: uppercase;
}
.panel-title { font-size: 15px; margin: 0; word-break: break-all; }
.facts { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
.row { display: flex; gap: 8px; font-size: 12px; align-items: baseline; }
.row.wide { display: block; }
.row.wide .row-val { display: block; margin-top: 1px; }
.row-key { color: var(--muted); flex: none; width: 58px; }
.row-val { color: var(--fg); word-break: break-all; user-select: all; font-size: 11px; }
.flags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.badge {
  background: var(--bg-3);
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  font: 10px var(--mono);
  padding: 3px 6px;
}
.badge.warn { border-color: #7a5a13; color: #fbbf24; }
.type-box { margin-bottom: 12px; }
.type-acts { display: flex; gap: 6px; margin-top: 5px; }
pre.type {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  color: #b9c4d4;
  font-size: 11px;
  margin: 0;
  overflow: hidden;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
/* A repository prints ten thousand characters of shape. Three lines say which
   type it is; the rest is for copying, so the box opens on demand and the copy
   button takes the whole string whether it is open or not. */
pre.type.clipped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
pre.type.open { max-height: 320px; overflow: auto; }
.list { margin-bottom: 12px; }
.list-title {
  color: var(--muted);
  font: 10px var(--mono);
  letter-spacing: 0.08em;
  margin: 0 0 5px;
  text-transform: uppercase;
}
.list-items { display: flex; flex-direction: column; gap: 3px; }
.entry {
  background: var(--bg);
  border: 1px solid var(--line);
  border-left: 3px solid var(--line);
  border-radius: 5px;
  color: var(--fg);
  cursor: pointer;
  font-size: 11px;
  padding: 5px 8px;
  text-align: left;
  word-break: break-all;
}
.entry:hover { background: var(--bg-3); }
.more { color: var(--muted); font-size: 11px; padding: 2px 4px; }
`;

const MARKUP = `
<div id="bar">
  <div class="bar-row">
    <span id="brand">atlas</span>
    <div class="seg" id="views"></div>
    <div class="menu" id="search-wrap">
      <input autocomplete="off" id="search" placeholder="search  /" spellcheck="false" type="search" />
      <div class="menu-body" hidden id="search-list" role="listbox"></div>
    </div>
    <span class="muted" id="search-count"></span>
    <div class="menu">
      <button id="pkg-btn" type="button">workspaces</button>
      <div class="menu-body" hidden id="pkg-menu"></div>
    </div>
    <label class="switch" id="layers-wrap"><input id="layers" type="checkbox" /> show layers</label>
    <label class="switch" id="external-wrap"><input id="external" type="checkbox" /> external</label>
    <button class="chip" hidden id="focus-chip" type="button"></button>
    <span class="spacer"></span>
    <div class="chips" id="zoom">
      <button class="chip" id="zoom-fit" title="fit the whole graph" type="button">fit</button>
      <button class="chip" id="zoom-in" title="zoom in" type="button">+</button>
      <button class="chip" id="zoom-out" title="zoom out" type="button">−</button>
    </div>
    <span class="muted mono" id="stats"></span>
  </div>
  <div class="bar-row bar-row-2">
    <span class="muted">edges</span>
    <div class="chips" id="edges"></div>
    <span class="spacer"></span>
    <div class="chips" id="legend"></div>
  </div>
</div>
<div id="body">
  <div id="cy"></div>
  <div hidden id="hint"></div>
  <aside id="panel"></aside>
</div>
`;

/** Replaces whatever the host page held with the viewer's own chrome. */
export const mountShell = () => {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  document.body.innerHTML = MARKUP;
};

/** The element with this id, or a thrown error naming the id that is missing. */
export const need = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`atlas: missing element #${id}`);
  }
  return found as T;
};

/** One element, with an optional class and text. The whole DOM builder here. */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
) => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};
