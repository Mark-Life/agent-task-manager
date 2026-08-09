import { describe, expect, it } from "bun:test";
import { rasterize, shapesFor, toSvg } from "./mark";
import { encodePng } from "./png";

const CHANNELS = 4;
const ALPHA = 3;

const alphaAt = (pixels: Uint8Array, size: number, x: number, y: number) =>
  pixels[(y * size + x) * CHANNELS + ALPHA];

describe("the tile", () => {
  it("rounds its own corners when nothing else will", () => {
    const pixels = rasterize(64, "rounded");
    expect(alphaAt(pixels, 64, 0, 0)).toBe(0);
    expect(alphaAt(pixels, 64, 32, 32)).toBe(255);
  });

  it("bleeds to every edge when the platform is going to crop it", () => {
    const pixels = rasterize(64, "maskable");
    expect(alphaAt(pixels, 64, 0, 0)).toBe(255);
    expect(alphaAt(pixels, 64, 63, 63)).toBe(255);
  });

  it("has no transparent pixel at all in Apple's variant", () => {
    // iOS composites a home-screen icon over a background of its own choosing,
    // so a transparent pixel is whatever that background happened to be.
    const pixels = rasterize(48, "square", { opaque: true });
    for (let at = ALPHA; at < pixels.length; at += CHANNELS) {
      expect(pixels[at]).toBe(255);
    }
  });
});

describe("the maskable variant's safe zone", () => {
  it("keeps the whole drawing inside the circle a launcher may crop to", () => {
    const size = 512;
    const centre = size / 2;
    const safeRadius = size * 0.4;
    const [, ...glyph] = shapesFor(size, "maskable");

    for (const shape of glyph) {
      for (const x of [shape.x, shape.x + shape.w]) {
        for (const y of [shape.y, shape.y + shape.h]) {
          expect(Math.hypot(x - centre, y - centre)).toBeLessThanOrEqual(
            safeRadius
          );
        }
      }
    }
  });
});

describe("the vector and the bitmaps", () => {
  it("are the same drawing", () => {
    const svg = toSvg(512, "rounded");
    expect(svg).toContain('viewBox="0 0 512 512"');
    // The tile plus three lanes plus three cards.
    expect(svg.match(/<rect /g)).toHaveLength(7);
  });
});

describe("the PNG container", () => {
  it("carries the signature and the size it was given", () => {
    const size = 32;
    const png = encodePng(size, size, rasterize(size, "rounded"));

    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([...png.subarray(12, 16)]).toEqual([73, 72, 68, 82]);
    const header = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect(header.getUint32(0)).toBe(size);
    expect(header.getUint32(4)).toBe(size);
  });

  it("refuses pixels that are not the size claimed", () => {
    expect(() => encodePng(4, 4, new Uint8Array(8))).toThrow();
  });
});
