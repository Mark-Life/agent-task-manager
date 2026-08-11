import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_DIR } from "./icons";

/**
 * The committed icon set against the files that name it.
 *
 * `bun run icons` writes `public/`, and the manifest and the document point
 * into it by hand. Nothing else would notice a rename: a manifest naming an
 * icon that is not there installs an app with no icon, and the only place that
 * shows up is a home screen.
 */

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Manifest sources are absolute paths on the origin; `public/` is that root. */
const LEADING_SLASH = /^\//;

const manifest = JSON.parse(
  readFileSync(join(PUBLIC_DIR, "manifest.webmanifest"), "utf8")
) as {
  readonly display: string;
  readonly icons: readonly { readonly purpose: string; readonly src: string }[];
  readonly scope: string;
  readonly start_url: string;
};

const html = readFileSync(join(APP_DIR, "index.html"), "utf8");

describe("the manifest", () => {
  it("names icons that are actually in public/", () => {
    for (const icon of manifest.icons) {
      expect(
        existsSync(join(PUBLIC_DIR, icon.src.replace(LEADING_SLASH, "")))
      ).toBe(true);
    }
  });

  it("ships a maskable icon, which is the one a launcher crops", () => {
    expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(
      true
    );
  });

  it("installs as an app rather than as a tab", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/");
  });
});

describe("the document", () => {
  it("links the manifest and the icon Safari reads instead of it", () => {
    expect(html).toContain('href="/manifest.webmanifest" rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(existsSync(join(PUBLIC_DIR, "apple-touch-icon.png"))).toBe(true);
  });

  it("carries the Apple metas a home-screen app is named and framed by", () => {
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain('name="apple-mobile-web-app-title"');
    expect(html).toContain('name="theme-color"');
  });
});
