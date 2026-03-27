// site2gif — GIF Encoder Web Worker
// Implements GIF89a with per-frame color quantization and LZW compression

self.onmessage = function (e) {
  const { frames, width, height, fps, quality, loop } = e.data;
  const delay = Math.round(100 / fps); // GIF delay in centiseconds

  const sampleFactor = quality === 'high' ? 1 : quality === 'medium' ? 10 : 20;

  const encoder = new GIFAssembler(width, height, delay, loop);

  let prevIndexed = null;

  for (let i = 0; i < frames.length; i++) {
    const pixels = new Uint8ClampedArray(frames[i]);
    const { palette, indexed } = quantizeFrame(pixels, width, height, sampleFactor);

    // Transparency optimization: mark unchanged pixels
    let transparentIndex = -1;
    if (prevIndexed && palette.length < 256) {
      transparentIndex = palette.length;
      palette.push([0, 0, 0]); // dummy transparent color
    }

    let optimizedIndexed = indexed;
    if (prevIndexed && transparentIndex >= 0) {
      optimizedIndexed = new Uint8Array(indexed.length);
      const pixelCount = width * height;
      let hasChange = false;
      for (let p = 0; p < pixelCount; p++) {
        const ri = p * 4;
        const prevRi = p * 4;
        // Compare original pixels (approximate: compare quantized indices isn't reliable across palettes)
        if (
          prevIndexed.origPixels &&
          Math.abs(pixels[ri] - prevIndexed.origPixels[ri]) < 4 &&
          Math.abs(pixels[ri + 1] - prevIndexed.origPixels[ri + 1]) < 4 &&
          Math.abs(pixels[ri + 2] - prevIndexed.origPixels[ri + 2]) < 4
        ) {
          optimizedIndexed[p] = transparentIndex;
        } else {
          optimizedIndexed[p] = indexed[p];
          hasChange = true;
        }
      }
      if (!hasChange) {
        // Frame identical to previous, still encode but all transparent
        optimizedIndexed[0] = indexed[0]; // at least one non-transparent pixel
      }
    }

    // Pad palette to power of 2
    const paletteSizeBits = getPaletteBits(palette.length);
    const fullPaletteSize = 1 << paletteSizeBits;
    while (palette.length < fullPaletteSize) {
      palette.push([0, 0, 0]);
    }

    encoder.addFrame(
      optimizedIndexed,
      palette,
      paletteSizeBits,
      transparentIndex >= 0 ? transparentIndex : -1,
      i === 0 ? 0 : 1 // disposal: 0 = none (first frame), 1 = keep (subsequent)
    );

    prevIndexed = { origPixels: new Uint8ClampedArray(pixels) };

    self.postMessage({ type: 'progress', value: (i + 1) / frames.length });
  }

  const result = encoder.finish();
  self.postMessage({ type: 'done', data: result }, [result]);
};

// ─── Color Quantization (Median Cut) ───

function quantizeFrame(pixels, width, height, sampleFactor) {
  const pixelCount = width * height;

  // Sample pixels for palette generation
  const samples = [];
  const step = Math.max(1, sampleFactor);
  for (let i = 0; i < pixelCount; i += step) {
    const ri = i * 4;
    if (pixels[ri + 3] > 128) { // skip mostly transparent
      samples.push([pixels[ri], pixels[ri + 1], pixels[ri + 2]]);
    }
  }

  if (samples.length === 0) {
    samples.push([0, 0, 0]);
  }

  // Median cut to 255 colors (reserve 1 slot for potential transparency)
  const palette = medianCut(samples, 255);

  // Build color lookup cache for fast mapping
  const colorCache = new Map();
  const indexed = new Uint8Array(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const ri = i * 4;
    const r = pixels[ri], g = pixels[ri + 1], b = pixels[ri + 2];
    const key = (r << 16) | (g << 8) | b;

    if (colorCache.has(key)) {
      indexed[i] = colorCache.get(key);
    } else {
      const idx = findNearest(palette, r, g, b);
      colorCache.set(key, idx);
      indexed[i] = idx;
    }
  }

  return { palette, indexed };
}

function medianCut(pixels, maxColors) {
  if (pixels.length <= maxColors) {
    return pixels.map(p => [p[0], p[1], p[2]]);
  }

  let boxes = [{ pixels, rMin: 255, rMax: 0, gMin: 255, gMax: 0, bMin: 255, bMax: 0 }];

  // Calculate bounds for initial box
  calcBounds(boxes[0]);

  while (boxes.length < maxColors) {
    // Find box with largest volume (range * count)
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].pixels.length < 2) continue;
      const b = boxes[i];
      const rRange = b.rMax - b.rMin;
      const gRange = b.gMax - b.gMin;
      const bRange = b.bMax - b.bMin;
      const volume = Math.max(rRange, gRange, bRange);
      const score = volume * boxes[i].pixels.length;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const box = boxes[bestIdx];
    const rRange = box.rMax - box.rMin;
    const gRange = box.gMax - box.gMin;
    const bRange = box.bMax - box.bMin;

    // Split along longest axis
    let channel;
    if (rRange >= gRange && rRange >= bRange) channel = 0;
    else if (gRange >= bRange) channel = 1;
    else channel = 2;

    box.pixels.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(box.pixels.length / 2);

    const box1 = { pixels: box.pixels.slice(0, mid) };
    const box2 = { pixels: box.pixels.slice(mid) };
    calcBounds(box1);
    calcBounds(box2);

    boxes.splice(bestIdx, 1, box1, box2);
  }

  // Average each box to get palette color
  return boxes.map(box => {
    let rSum = 0, gSum = 0, bSum = 0;
    for (const p of box.pixels) {
      rSum += p[0]; gSum += p[1]; bSum += p[2];
    }
    const n = box.pixels.length;
    return [Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)];
  });
}

function calcBounds(box) {
  box.rMin = 255; box.rMax = 0;
  box.gMin = 255; box.gMax = 0;
  box.bMin = 255; box.bMax = 0;
  for (const p of box.pixels) {
    if (p[0] < box.rMin) box.rMin = p[0]; if (p[0] > box.rMax) box.rMax = p[0];
    if (p[1] < box.gMin) box.gMin = p[1]; if (p[1] > box.gMax) box.gMax = p[1];
    if (p[2] < box.bMin) box.bMin = p[2]; if (p[2] > box.bMax) box.bMax = p[2];
  }
}

function findNearest(palette, r, g, b) {
  let bestDist = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i][0];
    const dg = g - palette[i][1];
    const db = b - palette[i][2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      if (dist === 0) break;
    }
  }
  return bestIdx;
}

function getPaletteBits(count) {
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 8) return 3;
  if (count <= 16) return 4;
  if (count <= 32) return 5;
  if (count <= 64) return 6;
  if (count <= 128) return 7;
  return 8;
}

// ─── LZW Compression ───

class LZWEncoder {
  constructor(minCodeSize) {
    this.minCodeSize = Math.max(2, minCodeSize);
    this.clearCode = 1 << this.minCodeSize;
    this.eoiCode = this.clearCode + 1;
  }

  encode(indexedPixels) {
    this.output = [];
    this.byteBuffer = [];
    this.bitBuffer = 0;
    this.bitCount = 0;

    let codeSize = this.minCodeSize + 1;
    let nextCode = this.eoiCode + 1;
    const table = new Map();

    // Initialize table
    for (let i = 0; i < this.clearCode; i++) {
      table.set(i.toString(36), i);
    }

    // Emit clear code
    this.emitCode(this.clearCode, codeSize);

    if (indexedPixels.length === 0) {
      this.emitCode(this.eoiCode, codeSize);
      this.flushBits();
      this.flushBytes();
      return new Uint8Array(this.output);
    }

    let current = indexedPixels[0].toString(36);

    for (let i = 1; i < indexedPixels.length; i++) {
      const next = indexedPixels[i].toString(36);
      const combined = current + ',' + next;

      if (table.has(combined)) {
        current = combined;
      } else {
        this.emitCode(table.get(current), codeSize);

        if (nextCode < 4096) {
          table.set(combined, nextCode);
          nextCode++;
          if (nextCode > (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
        } else {
          // Table full — reset
          this.emitCode(this.clearCode, codeSize);
          codeSize = this.minCodeSize + 1;
          nextCode = this.eoiCode + 1;
          table.clear();
          for (let j = 0; j < this.clearCode; j++) {
            table.set(j.toString(36), j);
          }
        }

        current = next;
      }
    }

    this.emitCode(table.get(current), codeSize);
    this.emitCode(this.eoiCode, codeSize);
    this.flushBits();
    this.flushBytes();

    return new Uint8Array(this.output);
  }

  emitCode(code, codeSize) {
    this.bitBuffer |= code << this.bitCount;
    this.bitCount += codeSize;

    while (this.bitCount >= 8) {
      this.byteBuffer.push(this.bitBuffer & 0xff);
      this.bitBuffer >>>= 8;
      this.bitCount -= 8;

      if (this.byteBuffer.length === 255) {
        this.flushBytes();
      }
    }
  }

  flushBits() {
    if (this.bitCount > 0) {
      this.byteBuffer.push(this.bitBuffer & 0xff);
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
  }

  flushBytes() {
    if (this.byteBuffer.length > 0) {
      this.output.push(this.byteBuffer.length);
      for (let i = 0; i < this.byteBuffer.length; i++) {
        this.output.push(this.byteBuffer[i]);
      }
      this.byteBuffer = [];
    }
  }
}

// ─── GIF File Assembler ───

class GIFAssembler {
  constructor(width, height, delay, loop) {
    this.width = width;
    this.height = height;
    this.delay = delay;
    this.loop = loop;
    this.bytes = [];
  }

  addByte(b) {
    this.bytes.push(b & 0xff);
  }

  addShort(val) {
    this.bytes.push(val & 0xff);
    this.bytes.push((val >> 8) & 0xff);
  }

  addString(str) {
    for (let i = 0; i < str.length; i++) {
      this.bytes.push(str.charCodeAt(i));
    }
  }

  addFrame(indexedPixels, palette, paletteBits, transparentIndex, disposal) {
    if (this.bytes.length === 0) {
      this.writeHeader(palette, paletteBits);
    }

    // Graphic Control Extension
    this.addByte(0x21); // Extension introducer
    this.addByte(0xf9); // GCE label
    this.addByte(0x04); // Block size
    const packed = ((disposal & 0x07) << 2) | (transparentIndex >= 0 ? 1 : 0);
    this.addByte(packed);
    this.addShort(this.delay);
    this.addByte(transparentIndex >= 0 ? transparentIndex : 0);
    this.addByte(0x00); // Block terminator

    // Image Descriptor
    this.addByte(0x2c); // Image separator
    this.addShort(0); // Left
    this.addShort(0); // Top
    this.addShort(this.width);
    this.addShort(this.height);
    // Local color table
    const lctFlag = 1;
    const lctSize = paletteBits - 1;
    const imgPacked = (lctFlag << 7) | (lctSize & 0x07);
    this.addByte(imgPacked);

    // Local Color Table
    const fullPaletteSize = 1 << paletteBits;
    for (let i = 0; i < fullPaletteSize; i++) {
      if (i < palette.length) {
        this.addByte(palette[i][0]);
        this.addByte(palette[i][1]);
        this.addByte(palette[i][2]);
      } else {
        this.addByte(0); this.addByte(0); this.addByte(0);
      }
    }

    // LZW compressed image data
    const minCodeSize = Math.max(2, paletteBits);
    this.addByte(minCodeSize);

    const lzw = new LZWEncoder(minCodeSize);
    const compressed = lzw.encode(indexedPixels);
    for (let i = 0; i < compressed.length; i++) {
      this.addByte(compressed[i]);
    }
    this.addByte(0x00); // Block terminator
  }

  writeHeader(palette, paletteBits) {
    // Header
    this.addString('GIF89a');

    // Logical Screen Descriptor
    this.addShort(this.width);
    this.addShort(this.height);
    // No global color table (using local per frame)
    const packed = 0x00; // No GCT
    this.addByte(packed);
    this.addByte(0); // Background color index
    this.addByte(0); // Pixel aspect ratio

    // Application Extension for looping (NETSCAPE2.0)
    if (this.loop) {
      this.addByte(0x21); // Extension
      this.addByte(0xff); // Application extension
      this.addByte(0x0b); // Block size
      this.addString('NETSCAPE2.0');
      this.addByte(0x03); // Sub-block size
      this.addByte(0x01); // Loop indicator
      this.addShort(0);   // Loop count (0 = infinite)
      this.addByte(0x00); // Block terminator
    }
  }

  finish() {
    if (this.bytes.length === 0) {
      this.writeHeader([[0, 0, 0]], 1);
    }
    this.addByte(0x3b); // GIF trailer
    const buffer = new ArrayBuffer(this.bytes.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < this.bytes.length; i++) {
      view[i] = this.bytes[i];
    }
    this.bytes = [];
    return buffer;
  }
}
