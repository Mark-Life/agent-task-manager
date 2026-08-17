/**
 * Bundles the viewer and splices it, with the graph, into one standalone
 * `atlas.html` that opens from `file://` with no network.
 *
 * `bun build ./index.html` is not the shortcut it looks like: it emits the
 * page and the script as two files and has no inline flag. So the JS is built
 * to stdout and spliced by hand, and both halves are escaped on the way in.
 * Node labels are repo paths, and one containing `</script` truncates the page
 * into a blank viewer that reports no error at all.
 */

import type { AtlasGraph } from "./graph";

/** The viewer entry, resolved off this file so the cwd does not matter. */
const VIEWER_ENTRY = new URL("./viewer/main.ts", import.meta.url).pathname;

/** Closes the inlined script early if it survives into the page. */
const escapeScript = (js: string) => js.replaceAll("</script", "<\\/script");

/** `<` never appears outside a string in JSON, so this escape is total. */
const escapeJson = (json: string) => json.replaceAll("<", "\\u003c");

/** Builds the viewer to a single minified string. */
const bundleViewer = async () => {
  const built = await Bun.build({
    entrypoints: [VIEWER_ENTRY],
    minify: true,
    target: "browser",
  });
  const [output] = built.outputs;
  if (!output) {
    throw new Error(`viewer bundle produced no output: ${VIEWER_ENTRY}`);
  }
  return await output.text();
};

/**
 * The page shell, which is everything that has to be right before the bundle
 * runs: the graph on `window.__ATLAS__`, and a dark background so the page does
 * not flash white. From `mountShell()` onward the viewer owns the body — it
 * replaces `body.innerHTML` outright — so any markup or rule written here for
 * the viewer's own elements would be thrown away before it was ever painted.
 */
const shell = ({
  graph,
  js,
}: {
  readonly graph: string;
  readonly js: string;
}) =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>atlas</title>
<style>html,body{margin:0;height:100%;background:#0b0e13;color:#e8ecf2}</style>
</head>
<body>
<script>window.__ATLAS__=${graph}</script>
<script type="module">${js}</script>
</body>
</html>
`;

/** The whole page as a string: shell, escaped graph JSON, bundled viewer JS. */
export const renderHtml = async (graph: AtlasGraph) => {
  const js = await bundleViewer();
  return shell({
    graph: escapeJson(JSON.stringify(graph)),
    js: escapeScript(js),
  });
};
