import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IconVariant, rasterize, toSvg } from "./mark";
import { encodePng } from "./png";

/**
 * Writes the icon set into `public/`, from the geometry in `mark.ts`.
 *
 * `bun run icons` in this workspace. The output is committed — a build must not
 * depend on this having been run — so the reason to run it is that the mark
 * changed, and the diff it produces is the review.
 */

/** The vector, which is also what `<link rel="icon">` points at. */
const SVG_UNITS = 512;

/** Apple's home-screen size. Everything else it needs, it scales from this. */
const APPLE_SIZE = 180;

interface Bitmap {
  readonly name: string;
  /** Apple's, which iOS composites over a background of its own. */
  readonly opaque?: boolean;
  readonly size: number;
  readonly variant: IconVariant;
}

/**
 * The set, and why it is this set.
 *
 * 192 and 512 are the two sizes the manifest is expected to carry — the first
 * is what a launcher draws, the second is what an install prompt and a splash
 * screen scale from. Each is drawn twice: once with its own corners for
 * anywhere it is shown as-is, and once bleeding to the edge for a platform that
 * masks it into whatever shape that platform likes. Apple's is a third drawing
 * because Safari reads neither of the others.
 */
const BITMAPS: readonly Bitmap[] = [
  { name: "icon-192.png", size: 192, variant: "rounded" },
  { name: "icon-512.png", size: 512, variant: "rounded" },
  { name: "icon-maskable-192.png", size: 192, variant: "maskable" },
  { name: "icon-maskable-512.png", size: 512, variant: "maskable" },
  {
    name: "apple-touch-icon.png",
    opaque: true,
    size: APPLE_SIZE,
    variant: "square",
  },
];

export const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const write = (name: string, bytes: Uint8Array | string) => {
  const path = join(PUBLIC_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
};

export const writeIcons = (): readonly string[] => [
  write("icon.svg", toSvg(SVG_UNITS, "rounded")),
  ...BITMAPS.map((bitmap) =>
    write(
      bitmap.name,
      encodePng(
        bitmap.size,
        bitmap.size,
        rasterize(bitmap.size, bitmap.variant, { opaque: bitmap.opaque })
      )
    )
  ),
];

if (import.meta.main) {
  for (const path of writeIcons()) {
    process.stdout.write(`${path}\n`);
  }
}
