'use strict';
// kanri のアイコンを生成する。外部ライブラリは使わず、zlib だけで PNG を書き出す。
// macOS では最後に iconutil を呼んで .icns にまとめる（無ければ PNG のまま残す）。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

// ---- PNG 書き出し ------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // フィルタなし
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 図形 ---------------------------------------------------------
// 角丸長方形の符号付き距離。0 未満なら内側。
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

const BG_TOP = [0x3d, 0x7e, 0xe0];
const BG_BOTTOM = [0x23, 0x52, 0xa8];
const BAR = [0xff, 0xff, 0xff];
const DOT = [0x4c, 0xc4, 0x7f]; // 起動中インジケータと同じ緑

// 1 サンプル分の色を返す（アルファは 0..1）
function sample(x, y, size) {
  const u = x / size;
  const v = y / size;

  // 台紙（角丸の四角）
  const bgD = roundedRectSdf(u, v, 0.5, 0.5, 0.46, 0.46, 0.105);
  if (bgD > 0) return null;

  // 一覧を表す 3 本のバー
  const bars = [
    [0.26, 0.315, 0.50],
    [0.26, 0.465, 0.42],
    [0.26, 0.615, 0.38],
  ];
  for (const [left, cy, width] of bars) {
    const h = 0.052;
    if (roundedRectSdf(u, v, left + width / 2, cy, width / 2, h / 2, h / 2) <= 0) return BAR;
  }
  // 起動中を表す緑の点
  if (Math.hypot(u - 0.725, v - 0.695) <= 0.065) return DOT;

  // 台紙は上から下へ少し暗くする
  const t = Math.min(Math.max((v - 0.04) / 0.92, 0), 1);
  return BG_TOP.map((c, i) => Math.round(c + (BG_BOTTOM[i] - c) * t));
}

const SUPERSAMPLE = 4;

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const c = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; hits++;
        }
      }
      const total = SUPERSAMPLE * SUPERSAMPLE;
      const i = (y * size + x) * 4;
      if (hits === 0) continue; // 透明のまま
      rgba[i] = Math.round(r / hits);
      rgba[i + 1] = Math.round(g / hits);
      rgba[i + 2] = Math.round(b / hits);
      rgba[i + 3] = Math.round((hits / total) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

// ---- 出力 ---------------------------------------------------------
const OUT_DIR = process.argv[2] || path.join(__dirname, '..', 'assets');
const ICONSET = path.join(OUT_DIR, 'kanri.iconset');

const SIZES = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

fs.mkdirSync(ICONSET, { recursive: true });
for (const [name, size] of SIZES) {
  fs.writeFileSync(path.join(ICONSET, name), render(size));
}
fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), render(512));

const icns = path.join(OUT_DIR, 'kanri.icns');
try {
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', icns], { stdio: 'pipe' });
  console.log(`アイコンを作成しました: ${icns}`);
} catch {
  console.log(`PNG を作成しました: ${ICONSET}（iconutil が無いため .icns は未生成）`);
}
