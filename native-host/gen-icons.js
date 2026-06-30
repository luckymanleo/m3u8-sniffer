// Generate PNG icons for the M3U8 Sniffer extension
// Draws a rounded-rect background with a download-arrow icon
// Usage: node gen-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function setPixel(data, x, y, r, g, b, a, width) {
  const offset = y * (width * 4 + 1) + 1 + x * 4;
  data[offset] = r;
  data[offset + 1] = g;
  data[offset + 2] = b;
  data[offset + 3] = a;
}

// Anti-aliased pixel: blend src RGBA over dst
function blendPixel(data, x, y, r, g, b, a, width) {
  if (a <= 0) return;
  if (a >= 255) { setPixel(data, x, y, r, g, b, 255, width); return; }
  const offset = y * (width * 4 + 1) + 1 + x * 4;
  const dstR = data[offset], dstG = data[offset + 1], dstB = data[offset + 2], dstA = data[offset + 3];
  const srcAlpha = a / 255;
  const dstAlpha = dstA / 255;
  const outAlpha = srcAlpha + dstAlpha * (1 - srcAlpha);
  if (outAlpha <= 0) return;
  data[offset]     = Math.round((r * srcAlpha + dstR * dstAlpha * (1 - srcAlpha)) / outAlpha);
  data[offset + 1] = Math.round((g * srcAlpha + dstG * dstAlpha * (1 - srcAlpha)) / outAlpha);
  data[offset + 2] = Math.round((b * srcAlpha + dstB * dstAlpha * (1 - srcAlpha)) / outAlpha);
  data[offset + 3] = Math.round(outAlpha * 255);
}

function distToRoundedRect(px, py, cx, cy, w, h, r) {
  // Signed distance to rounded rectangle (negative inside, positive outside)
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  if (dx <= 0 && dy <= 0) return Math.max(dx, dy); // inside rect body
  if (dx > 0 && dy > 0) return Math.sqrt(dx * dx + dy * dy) - r; // corner region
  return dx > 0 ? dx : dy; // edge region
}

function createIcon(size) {
  const width = size;
  const height = size;

  // Raw pixel data with filter bytes
  const rawData = Buffer.alloc((width * 4 + 1) * height);

  const cx = size / 2;
  const cy = size / 2;
  const bgSize = size * 0.82;
  const cornerR = size * 0.2;

  // Colors
  const bgR = 26, bgG = 115, bgB = 232;    // #1a73e8 blue
  const fgR = 255, fgG = 255, fgB = 255;    // white arrow
  const shR = 11, shG = 80, shB = 180;       // darker blue for depth

  // Draw rounded rect background with anti-aliased edges
  for (let y = 0; y < height; y++) {
    rawData[y * (width * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const d = distToRoundedRect(x + 0.5, y + 0.5, cx, cy, bgSize, bgSize, cornerR);

      if (d < -1) {
        // Solid inside
        setPixel(rawData, x, y, bgR, bgG, bgB, 255, width);
      } else if (d < 1) {
        // Anti-aliased edge
        const alpha = Math.round((1 - (d + 1) / 2) * 255);
        blendPixel(rawData, x, y, bgR, bgG, bgB, alpha, width);
      }
      // else transparent outside
    }
  }

  // Draw download arrow (white)
  // Arrow: a downward shaft with an arrowhead at bottom
  const arrowTop = size * 0.22;
  const arrowBottom = size * 0.78;
  const shaftHalfW = size * 0.06;
  const headHalfW = size * 0.18;

  // Arrow shaft (vertical line)
  for (let y = Math.floor(arrowTop); y <= Math.floor(arrowBottom - size * 0.08); y++) {
    for (let x = Math.floor(cx - shaftHalfW); x <= Math.floor(cx + shaftHalfW); x++) {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        setPixel(rawData, x, y, fgR, fgG, fgB, 255, width);
      }
    }
  }

  // Arrow head (triangle pointing down)
  const headTop = arrowBottom - size * 0.25;
  for (let y = Math.floor(headTop); y <= Math.floor(arrowBottom); y++) {
    const progress = (y - headTop) / (arrowBottom - headTop);
    const halfW = shaftHalfW + (headHalfW - shaftHalfW) * progress;
    for (let x = Math.floor(cx - halfW); x <= Math.floor(cx + halfW); x++) {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        setPixel(rawData, x, y, fgR, fgG, fgB, 255, width);
      }
    }
  }

  // Small horizontal bar at top of shaft (arrow crossbar)
  const barY = arrowTop + size * 0.06;
  for (let y = Math.floor(barY); y <= Math.floor(barY + shaftHalfW * 2); y++) {
    for (let x = Math.floor(cx - headHalfW * 0.6); x <= Math.floor(cx + headHalfW * 0.6); x++) {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        blendPixel(rawData, x, y, fgR, fgG, fgB, 255, width);
      }
    }
  }

  // Deflate
  const deflated = zlib.deflateSync(rawData);

  // Build PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const ihdrChunk = Buffer.concat([Buffer.from('IHDR'), ihdrData, Buffer.alloc(4)]);
  ihdrChunk.writeUInt32BE(crc32(ihdrChunk.subarray(0, 17)), 17);

  const idatChunk = Buffer.concat([Buffer.from('IDAT'), deflated, Buffer.alloc(4)]);
  idatChunk.writeUInt32BE(crc32(idatChunk.subarray(0, idatChunk.length - 4)), idatChunk.length - 4);

  const iendChunk = Buffer.concat([Buffer.from('IEND'), Buffer.alloc(4)]);
  iendChunk.writeUInt32BE(crc32(iendChunk.subarray(0, 4)), 4);

  function chunk(buf) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length - 8, 0);
    return Buffer.concat([len, buf]);
  }

  return Buffer.concat([signature, chunk(ihdrChunk), chunk(idatChunk), chunk(iendChunk)]);
}

const iconsDir = path.join(__dirname, '..', 'extension', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

[16, 48, 128].forEach(size => {
  const png = createIcon(size);
  const filepath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filepath, png);
  console.log(`Created ${filepath} (${png.length} bytes)`);
});

console.log('Icons generated!');
