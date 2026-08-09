/**
 * The mark, as geometry rather than as a file.
 *
 * There was no logo to start from, so this is the drawing itself: three board
 * columns with one card in each, stepping down and to the right — the board
 * this app is, and a task crossing it. It is built from rounded rectangles and
 * nothing else, which is what lets one description feed both renderings. The
 * SVG a browser scales and the PNGs a home screen wants come out of the same
 * `shapesFor` call, so the vector and the bitmaps cannot drift apart the way
 * hand-exported icons do.
 *
 * Nothing here reads a file or writes one; `tools/icons.ts` does that.
 */

/** A colour as the rasteriser wants it: eight-bit channels, and alpha as a fraction. */
export interface Rgba {
  /** 0–1. Anything below 1 is composited over what is already painted. */
  readonly a: number;
  readonly b: number;
  readonly g: number;
  readonly r: number;
}

/** One rounded rectangle, in the units of the image it belongs to. */
export interface Shape {
  readonly fill: Rgba;
  readonly h: number;
  /** Corner radius. Zero is a plain rectangle. */
  readonly r: number;
  readonly w: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Which of the three shapes an icon is asked for.
 *
 * `rounded` is the icon as a browser or a launcher draws it unaltered, so it
 * carries its own corners and leaves the outside transparent. `maskable` hands
 * the corners to the platform: it must bleed to every edge, and its content has
 * to survive a circular crop, so the drawing sits smaller inside it. `square`
 * is Apple's — iOS applies its own mask and composites what is left over an
 * opaque background, so a pre-rounded icon there shows the seam.
 */
export type IconVariant = "maskable" | "rounded" | "square";

/** The dark palette's `--background`, which is also the manifest's. */
export const INK: Rgba = { a: 1, b: 0x0a, g: 0x0a, r: 0x0a };

/** The dark palette's `--primary`, `oklch(0.7869 0.1165 192.26)` in sRGB. */
export const MARK: Rgba = { a: 1, b: 0xcd, g: 0xd1, r: 0x47 };

/** How much of the mark's colour a column keeps. Enough to read as a lane, not as a card. */
const COLUMN_ALPHA = 0.26;

/**
 * The drawing, in a 100-unit square.
 *
 * Three lanes across, one card in each, each card a card's height lower than
 * the one to its left — so the diagonal is exact rather than eyeballed, and the
 * whole figure is symmetric about both axes.
 */
const GLYPH_UNITS = 100;
const LANE_X = [6, 38, 70] as const;
const LANE_W = 24;
const LANE_Y = 6;
const LANE_H = 88;
const LANE_R = 7;
const CARD_INSET = 4;
const CARD_Y = [14, 38, 62] as const;
const CARD_H = 24;
const CARD_R = 5;

/**
 * How much of the tile the drawing is allowed, per variant.
 *
 * A maskable icon may be cropped to the circle inscribed in the middle 80% of
 * the tile, so everything that matters has to fit inside a circle of radius
 * 0.4. A 0.56-wide square reaches 0.56 × √2 ÷ 2 ≈ 0.396 into its corners, which
 * is inside that circle with nothing to spare and nothing wasted.
 */
const GLYPH_SPAN: Record<IconVariant, number> = {
  maskable: 0.56,
  rounded: 0.68,
  square: 0.68,
};

/**
 * The tile's own corner, as a fraction of its side. Apple's home-screen mask is
 * close to this, so an icon drawn with it sits where the platform's would.
 */
const TILE_RADIUS = 0.2237;

/** Alpha the platform is not going to composite for us. */
const OPAQUE = 1;

const scaled = (shape: Shape, factor: number, offset: number): Shape => ({
  fill: shape.fill,
  h: shape.h * factor,
  r: shape.r * factor,
  w: shape.w * factor,
  x: offset + shape.x * factor,
  y: offset + shape.y * factor,
});

/** The lanes and the cards, in glyph units, back to front. */
const glyphShapes = (): readonly Shape[] => [
  ...LANE_X.map((x) => ({
    fill: { ...MARK, a: COLUMN_ALPHA },
    h: LANE_H,
    r: LANE_R,
    w: LANE_W,
    x,
    y: LANE_Y,
  })),
  ...LANE_X.map((x, lane) => ({
    fill: MARK,
    h: CARD_H,
    r: CARD_R,
    w: LANE_W - CARD_INSET * 2,
    x: x + CARD_INSET,
    y: CARD_Y[lane] ?? LANE_Y,
  })),
];

/**
 * Everything an icon of this size and variant is made of, painted in order.
 *
 * The tile comes first because every later shape sits on it; a renderer only
 * has to walk the list and composite each one over what it already has.
 */
export const shapesFor = (
  size: number,
  variant: IconVariant
): readonly Shape[] => {
  const span = GLYPH_SPAN[variant];
  const factor = (size * span) / GLYPH_UNITS;
  const offset = (size * (1 - span)) / 2;

  return [
    {
      fill: INK,
      h: size,
      r: variant === "rounded" ? size * TILE_RADIUS : 0,
      w: size,
      x: 0,
      y: 0,
    },
    ...glyphShapes().map((shape) => scaled(shape, factor, offset)),
  ];
};

/** How far a point is outside a rounded rectangle; negative inside, zero on the edge. */
const distanceTo = (shape: Shape, px: number, py: number) => {
  const halfW = shape.w / 2;
  const halfH = shape.h / 2;
  const dx = Math.abs(px - (shape.x + halfW)) - (halfW - shape.r);
  const dy = Math.abs(py - (shape.y + halfH)) - (halfH - shape.r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - shape.r;
};

/**
 * How much of one pixel a shape covers, from the distance to its edge.
 *
 * The distance is in pixels, so a centre exactly on the edge is half covered
 * and the transition takes one pixel — which is what antialiasing is. Sampling
 * the shape at several points per pixel would approximate the same number more
 * slowly and less smoothly.
 */
const coverage = (shape: Shape, px: number, py: number) =>
  Math.min(Math.max(0.5 - distanceTo(shape, px, py), 0), 1);

/** Source-over, on straight (unpremultiplied) channels. */
const over = (
  under: readonly [number, number, number, number],
  fill: Rgba,
  alpha: number
): [number, number, number, number] => {
  const out = alpha + under[3] * (1 - alpha);
  if (out === 0) {
    return [0, 0, 0, 0];
  }
  const mix = (top: number, bottom: number) =>
    (top * alpha + bottom * under[3] * (1 - alpha)) / out;
  return [
    mix(fill.r, under[0]),
    mix(fill.g, under[1]),
    mix(fill.b, under[2]),
    out,
  ];
};

const CHANNELS = 4;
const FULL_BYTE = 255;

/**
 * The icon as RGBA bytes, one row after another.
 *
 * `opaque` is for Apple's variant: iOS composites a home-screen icon over a
 * background of its own choosing and a transparent pixel there is not a
 * transparent pixel, it is whatever that background happened to be. Forcing the
 * alpha channel to full makes what ships the thing that gets drawn.
 */
export const rasterize = (
  size: number,
  variant: IconVariant,
  { opaque = false }: { readonly opaque?: boolean } = {}
): Uint8Array => {
  const shapes = shapesFor(size, variant);
  const pixels = new Uint8Array(size * size * CHANNELS);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let pixel: [number, number, number, number] = [0, 0, 0, 0];
      for (const shape of shapes) {
        const alpha = coverage(shape, x + 0.5, y + 0.5) * shape.fill.a;
        if (alpha > 0) {
          pixel = over(pixel, shape.fill, alpha);
        }
      }
      const at = (y * size + x) * CHANNELS;
      pixels[at] = Math.round(pixel[0]);
      pixels[at + 1] = Math.round(pixel[1]);
      pixels[at + 2] = Math.round(pixel[2]);
      pixels[at + 3] = opaque ? FULL_BYTE : Math.round(pixel[3] * FULL_BYTE);
    }
  }

  return pixels;
};

const hex = (value: number) => value.toString(16).padStart(2, "0");

const cssColor = (fill: Rgba) => `#${hex(fill.r)}${hex(fill.g)}${hex(fill.b)}`;

const round = (value: number) => Number(value.toFixed(2));

/**
 * The same drawing as a vector, for `<link rel="icon">` and for the manifest's
 * "any" size — one file that stays sharp at every size a browser invents.
 */
export const toSvg = (size: number, variant: IconVariant): string => {
  const body = shapesFor(size, variant)
    .map((shape) => {
      const opacity =
        shape.fill.a === OPAQUE ? "" : ` opacity="${shape.fill.a}"`;
      return `  <rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}" rx="${round(shape.r)}" fill="${cssColor(shape.fill)}"${opacity}/>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Agent Task Manager">
${body}
</svg>
`;
};
