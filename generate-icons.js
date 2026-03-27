#!/usr/bin/env node
// Generate site2gif extension icons as PNG files

const { createCanvas } = (() => {
  // Use OffscreenCanvas-compatible approach via built-in Node canvas alternative
  // We'll write raw PNG bytes directly
  return { createCanvas: null };
})();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Minimal PNG encoder - writes valid PNG files
function createPNG(width, height, drawFn) {
  const pixels = new Uint8Array(width * height * 4);
  const ctx = {
    width, height, pixels,
    setPixel(x, y, r, g, b, a = 255) {
      if (x < 0 || x >= width || y < 0 || y >= height) return;
      x = Math.floor(x);
      y = Math.floor(y);
      const i = (y * width + x) * 4;
      // Alpha blending
      const srcA = a / 255;
      const dstA = pixels[i + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      if (outA > 0) {
        pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
        pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
        pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
        pixels[i + 3] = Math.round(outA * 255);
      }
    },
    fillRect(x, y, w, h, r, g, b, a = 255) {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          this.setPixel(x + dx, y + dy, r, g, b, a);
        }
      }
    },
    fillRoundedRect(x, y, w, h, radius, r, g, b, a = 255) {
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const px = x + dx;
          const py = y + dy;
          // Check corners
          let inside = true;
          if (dx < radius && dy < radius) {
            inside = (dx - radius) ** 2 + (dy - radius) ** 2 <= radius ** 2;
          } else if (dx >= w - radius && dy < radius) {
            inside = (dx - (w - radius - 1)) ** 2 + (dy - radius) ** 2 <= radius ** 2;
          } else if (dx < radius && dy >= h - radius) {
            inside = (dx - radius) ** 2 + (dy - (h - radius - 1)) ** 2 <= radius ** 2;
          } else if (dx >= w - radius && dy >= h - radius) {
            inside = (dx - (w - radius - 1)) ** 2 + (dy - (h - radius - 1)) ** 2 <= radius ** 2;
          }
          if (inside) {
            this.setPixel(px, py, r, g, b, a);
          }
        }
      }
    },
    fillCircle(cx, cy, radius, r, g, b, a = 255) {
      const r2 = radius * radius;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy <= r2) {
            this.setPixel(Math.round(cx + dx), Math.round(cy + dy), r, g, b, a);
          }
        }
      }
    }
  };

  drawFn(ctx);

  // Build PNG
  const zlib = require('zlib');

  // Filter: prepend 0 (None) to each row
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (1 + width * 4) + 1 + x * 4;
      rawData[di] = pixels[si];
      rawData[di + 1] = pixels[si + 1];
      rawData[di + 2] = pixels[si + 2];
      rawData[di + 3] = pixels[si + 3];
    }
  }

  const compressed = zlib.deflateSync(rawData);

  // CRC32
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
  }

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function drawIcon(ctx) {
  const s = ctx.width;

  // Gradient background (approximate with vertical stripes)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const t = (x + y) / (2 * s);
      const r = Math.round(233 + (124 - 233) * t);
      const g = Math.round(69 + (58 - 69) * t);
      const b = Math.round(96 + (237 - 96) * t);
      // Check rounded rect
      const radius = s * 0.2;
      let inside = true;
      if (x < radius && y < radius) {
        inside = (x - radius) ** 2 + (y - radius) ** 2 <= radius ** 2;
      } else if (x >= s - radius && y < radius) {
        inside = (x - (s - radius)) ** 2 + (y - radius) ** 2 <= radius ** 2;
      } else if (x < radius && y >= s - radius) {
        inside = (x - radius) ** 2 + (y - (s - radius)) ** 2 <= radius ** 2;
      } else if (x >= s - radius && y >= s - radius) {
        inside = (x - (s - radius)) ** 2 + (y - (s - radius)) ** 2 <= radius ** 2;
      }
      if (inside) {
        ctx.setPixel(x, y, r, g, b, 255);
      }
    }
  }

  // Film strip perforations
  const perfSize = Math.max(1, Math.round(s * 0.06));
  const perfGap = Math.round(s * 0.14);
  for (let y = Math.round(s * 0.12); y < s * 0.9; y += perfGap) {
    ctx.fillRect(Math.round(s * 0.06), y, perfSize, perfSize, 255, 255, 255, 40);
    ctx.fillRect(Math.round(s - s * 0.06 - perfSize), y, perfSize, perfSize, 255, 255, 255, 40);
  }

  // "GIF" text - simple bitmap font
  if (s >= 48) {
    drawText(ctx, 'GIF', s);
  } else if (s >= 16) {
    drawTextSmall(ctx, 'G', s);
  }

  // Record dot
  const dotR = Math.max(1, Math.round(s * 0.08));
  const dotX = Math.round(s * 0.78);
  const dotY = Math.round(s * 0.22);
  ctx.fillCircle(dotX, dotY, dotR + 1, 255, 255, 255, 200);
  ctx.fillCircle(dotX, dotY, dotR, 255, 107, 107, 255);
}

function drawText(ctx, text, s) {
  // Simple pixel art letters for "GIF"
  const fontSize = Math.round(s * 0.28);
  const startX = Math.round(s * 0.18);
  const startY = Math.round(s * 0.36);
  const letterW = Math.round(fontSize * 0.7);
  const gap = Math.round(fontSize * 0.15);
  const thick = Math.max(1, Math.round(fontSize * 0.22));

  let x = startX;

  // G
  ctx.fillRect(x + thick, startY, letterW - thick, thick, 255, 255, 255, 230); // top
  ctx.fillRect(x, startY + thick, thick, fontSize - 2 * thick, 255, 255, 255, 230); // left
  ctx.fillRect(x + thick, startY + fontSize - thick, letterW - thick, thick, 255, 255, 255, 230); // bottom
  ctx.fillRect(x + letterW - thick, startY + Math.round(fontSize * 0.5), thick, Math.round(fontSize * 0.5) - thick, 255, 255, 255, 230); // right-bottom
  ctx.fillRect(x + Math.round(letterW * 0.45), startY + Math.round(fontSize * 0.45), letterW - Math.round(letterW * 0.45), thick, 255, 255, 255, 230); // middle

  x += letterW + gap;

  // I
  ctx.fillRect(x, startY, letterW, thick, 255, 255, 255, 230); // top
  ctx.fillRect(x + Math.round((letterW - thick) / 2), startY + thick, thick, fontSize - 2 * thick, 255, 255, 255, 230); // middle
  ctx.fillRect(x, startY + fontSize - thick, letterW, thick, 255, 255, 255, 230); // bottom

  x += letterW + gap;

  // F
  ctx.fillRect(x, startY, letterW, thick, 255, 255, 255, 230); // top
  ctx.fillRect(x, startY + thick, thick, fontSize - thick, 255, 255, 255, 230); // left
  ctx.fillRect(x + thick, startY + Math.round(fontSize * 0.45), Math.round(letterW * 0.6), thick, 255, 255, 255, 230); // middle
}

function drawTextSmall(ctx, letter, s) {
  // For 16x16, just draw a simple G
  const cx = Math.round(s / 2);
  const cy = Math.round(s / 2);
  const r = Math.round(s * 0.28);
  ctx.fillCircle(cx, cy, r + 1, 255, 255, 255, 200);
  ctx.fillCircle(cx, cy, r - 1, 0, 0, 0, 0); // clear inside (won't work with alpha, so skip)
  // Just draw a filled circle with the gradient showing through... simpler: draw a solid white "G" shape
  const t = Math.max(1, Math.round(s * 0.15));
  ctx.fillRect(cx - r, cy - r, r * 2, t, 255, 255, 255, 220); // top
  ctx.fillRect(cx - r, cy - r, t, r * 2, 255, 255, 255, 220); // left
  ctx.fillRect(cx - r, cy + r - t, r * 2, t, 255, 255, 255, 220); // bottom
  ctx.fillRect(cx + r - t, cy, t, r, 255, 255, 255, 220); // right bottom
  ctx.fillRect(cx, cy, r, t, 255, 255, 255, 220); // middle bar
}

// Generate icons
const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

for (const size of sizes) {
  const png = createPNG(size, size, drawIcon);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
}

console.log('Done! Icons generated.');
