import { inflateSync } from 'node:zlib';

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced — what browser screenshots produce). */
export function decodePng(buf: Buffer): { width: number; height: number; channels: number; data: Uint8Array } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6))
        throw new Error(`unsupported PNG (depth ${depth}, colour ${color}, interlace ${interlace})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[row + x - channels]! : 0;
      const b = y > 0 ? data[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? data[row - stride + x - channels]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[row + x] = v & 0xff;
    }
  }
  return { width, height, channels, data };
}

/** Mean brightness (0–255) of a rectangle given as fractions of the image's width and height. */
export function regionBrightness(png: Buffer, r: { x0: number; x1: number; y0: number; y1: number }): number {
  const { width, height, channels, data } = decodePng(png);
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(height * r.y0); y < Math.ceil(height * r.y1); y++) {
    for (let x = Math.floor(width * r.x0); x < Math.ceil(width * r.x1); x++) {
      const i = (y * width + x) * channels;
      sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      n++;
    }
  }
  return sum / Math.max(1, n);
}
