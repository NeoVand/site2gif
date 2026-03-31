#!/usr/bin/env node
// Generate Talkover extension icons as PNG files

const { createCanvas } = (() => {
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
    },
    fillEllipse(cx, cy, rx, ry, r, g, b, a = 255) {
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) {
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

  // Gradient background (blue-purple, matching the Talkover save button gradient)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const t = (x + y) / (2 * s);
      // #4f8efa to #6c6cf1
      const r = Math.round(79 + (108 - 79) * t);
      const g = Math.round(142 + (108 - 142) * t);
      const b = Math.round(250 + (241 - 250) * t);
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

  // Screen rectangle (representing the tab)
  const screenX = Math.round(s * 0.12);
  const screenY = Math.round(s * 0.18);
  const screenW = Math.round(s * 0.76);
  const screenH = Math.round(s * 0.52);
  const screenR = Math.max(1, Math.round(s * 0.06));
  ctx.fillRoundedRect(screenX, screenY, screenW, screenH, screenR, 255, 255, 255, 50);

  // Webcam circle (PIP in bottom-right corner of screen)
  const camR = Math.max(2, Math.round(s * 0.12));
  const camX = Math.round(screenX + screenW - s * 0.08);
  const camY = Math.round(screenY + screenH - s * 0.04);
  ctx.fillCircle(camX, camY, camR, 255, 255, 255, 216);

  // Person silhouette in webcam circle
  const headR = Math.max(1, Math.round(camR * 0.3));
  ctx.fillCircle(camX, Math.round(camY - camR * 0.18), headR, 91, 126, 247, 255);
  ctx.fillEllipse(camX, Math.round(camY + camR * 0.35), Math.round(camR * 0.5), Math.round(camR * 0.35), 91, 126, 247, 255);

  // Speech lines at bottom (the "talk over" element)
  if (s >= 48) {
    const thick = Math.max(1, Math.round(s * 0.025));
    for (let i = 0; i < 3; i++) {
      const lineX = Math.round(s * 0.18 + i * s * 0.1);
      const lineY = Math.round(s * 0.82);
      const lineW = Math.round(s * 0.06);
      ctx.fillRect(lineX, lineY, lineW, thick, 255, 255, 255, 178);
    }
  }

  // Record dot (top-right)
  const dotR = Math.max(1, Math.round(s * 0.06));
  const dotX = Math.round(s * 0.82);
  const dotY = Math.round(s * 0.18);
  ctx.fillCircle(dotX, dotY, dotR + 1, 255, 255, 255, 128);
  ctx.fillCircle(dotX, dotY, dotR, 255, 107, 107, 255);
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
