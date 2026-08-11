import { deflateSync } from "node:zlib";

/**
 * Eight-bit RGBA out as a PNG, and nothing else.
 *
 * A dependency would do this, and every one of them is a native build or a
 * rasteriser we do not need: the icons are rounded rectangles drawn by
 * `mark.ts`, so all that is missing between those pixels and a file on disk is
 * the container. It is three chunks and a checksum, `node:zlib` does the
 * compression, and it means the icon set can be regenerated on any machine that
 * can already run the repository.
 *
 * Colour type 6 (truecolour with alpha) at bit depth 8, filter 0 on every row.
 * Filters exist to help the compressor and these images are flat colour, so
 * choosing one per row would buy bytes nobody is counting.
 */

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_POLYNOMIAL = 0xed_b8_83_20;
const BYTE_VALUES = 256;
const BITS_PER_BYTE = 8;
const CRC_SEED = 0xff_ff_ff_ff;
const CHANNELS = 4;
const BIT_DEPTH = 8;
const COLOR_TYPE_RGBA = 6;
const HEADER_BYTES = 13;
const LENGTH_BYTES = 4;
const TYPE_BYTES = 4;
const CRC_BYTES = 4;
/** zlib's own scale, not a byte count: 9 is smallest output. */
const MAX_COMPRESSION = 9;

const CRC_TABLE = (() => {
  const table = new Uint32Array(BYTE_VALUES);
  for (let index = 0; index < BYTE_VALUES; index += 1) {
    let value = index;
    for (let bit = 0; bit < BITS_PER_BYTE; bit += 1) {
      value = value & 1 ? CRC_POLYNOMIAL ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array) => {
  let crc = CRC_SEED;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> BITS_PER_BYTE);
  }
  return (crc ^ CRC_SEED) >>> 0;
};

/** One PNG chunk: its length, its four-letter name, its payload, its checksum. */
const chunk = (type: string, payload: Uint8Array) => {
  const framed = new Uint8Array(
    LENGTH_BYTES + TYPE_BYTES + payload.length + CRC_BYTES
  );
  const view = new DataView(framed.buffer);
  view.setUint32(0, payload.length);
  for (let index = 0; index < TYPE_BYTES; index += 1) {
    framed[LENGTH_BYTES + index] = type.charCodeAt(index);
  }
  framed.set(payload, LENGTH_BYTES + TYPE_BYTES);
  view.setUint32(
    LENGTH_BYTES + TYPE_BYTES + payload.length,
    crc32(
      framed.subarray(LENGTH_BYTES, LENGTH_BYTES + TYPE_BYTES + payload.length)
    )
  );
  return framed;
};

const header = (width: number, height: number) => {
  const payload = new Uint8Array(HEADER_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint32(0, width);
  view.setUint32(LENGTH_BYTES, height);
  payload[BITS_PER_BYTE] = BIT_DEPTH;
  payload[BITS_PER_BYTE + 1] = COLOR_TYPE_RGBA;
  return payload;
};

/** Every row prefixed with its filter byte, which is what the compressor is handed. */
const scanlines = (width: number, height: number, pixels: Uint8Array) => {
  const stride = width * CHANNELS;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(
      pixels.subarray(row * stride, (row + 1) * stride),
      row * (stride + 1) + 1
    );
  }
  return raw;
};

export const encodePng = (
  width: number,
  height: number,
  pixels: Uint8Array
): Uint8Array => {
  if (pixels.length !== width * height * CHANNELS) {
    throw new Error(
      `${width}×${height} needs ${width * height * CHANNELS} bytes of RGBA, got ${pixels.length}`
    );
  }

  const data = deflateSync(scanlines(width, height, pixels), {
    level: MAX_COMPRESSION,
  });
  const parts = [
    SIGNATURE,
    chunk("IHDR", header(width, height)),
    chunk(
      "IDAT",
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    ),
    chunk("IEND", new Uint8Array(0)),
  ];

  const file = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0)
  );
  let at = 0;
  for (const part of parts) {
    file.set(part, at);
    at += part.length;
  }
  return file;
};
