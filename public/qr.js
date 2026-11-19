// Small QR code encoder (byte mode, error correction M, versions 1-10) so a QR can be drawn on the stream without any library.
const EXP = new Uint8Array(512); const LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsGen(n) { let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; } return g; }
function rsEc(data, n) {
  const g = rsGen(n); const res = new Array(n).fill(0);
  for (const d of data) { const f = d ^ res.shift(); res.push(0); if (f) for (let i = 0; i < n; i++) res[i] ^= mul(g[i + 1], f); }
  return res;
}
// per version, level M: total codewords, EC codewords per block, [blocks, data codewords per block] groups, alignment pattern centres
const VER = [null,
  { t: 26, ec: 10, b: [[1, 16]], al: [] }, { t: 44, ec: 16, b: [[1, 28]], al: [6, 18] }, { t: 70, ec: 26, b: [[1, 44]], al: [6, 22] },
  { t: 100, ec: 18, b: [[2, 32]], al: [6, 26] }, { t: 134, ec: 24, b: [[2, 43]], al: [6, 30] }, { t: 172, ec: 16, b: [[4, 27]], al: [6, 34] },
  { t: 196, ec: 18, b: [[4, 31]], al: [6, 22, 38] }, { t: 242, ec: 22, b: [[2, 38], [2, 39]], al: [6, 24, 42] },
  { t: 292, ec: 22, b: [[3, 36], [2, 37]], al: [6, 26, 46] }, { t: 346, ec: 26, b: [[4, 43], [1, 44]], al: [6, 28, 50] }];
const dataCw = (v) => VER[v].b.reduce((a, [n, c]) => a + n * c, 0);
const bit = (x, i) => ((x >>> i) & 1) === 1;

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let ver = 0;
  for (let v = 1; v <= 10; v++) { if (bytes.length <= Math.floor((dataCw(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8)) { ver = v; break; } }
  if (!ver) throw new Error('Text too long for the QR code');
  const size = 17 + 4 * ver; const total = dataCw(ver);
  // bit stream
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, total * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; data.length < total; p++) data.push(p % 2 ? 0x11 : 0xEC);
  // blocks + error correction + interleave
  const blocks = []; let off = 0;
  for (const [n, c] of VER[ver].b) for (let i = 0; i < n; i++) { blocks.push(data.slice(off, off + c)); off += c; }
  const ecs = blocks.map((b) => rsEc(b, VER[ver].ec));
  const out = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.length)); i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < VER[ver].ec; i++) for (const e of ecs) out.push(e[i]);
  // function patterns
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, v) => { if (x >= 0 && y >= 0 && x < size && y < size) { mod[y][x] = v; fn[y][x] = true; } };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); setF(cx + dx, cy + dy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = VER[ver].al;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const formatBits = (mask) => {
    const d = (0 << 3) | mask; let rem = d; // error correction level M = 0
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((d << 10) | rem) ^ 0x5412;
  };
  const drawFormat = (mask) => {
    const b = formatBits(mask);
    for (let i = 0; i <= 5; i++) setF(8, i, bit(b, i));
    setF(8, 7, bit(b, 6)); setF(8, 8, bit(b, 7)); setF(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(b, i));
    setF(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3); const c = Math.floor(i / 3); setF(a, c, bit(b, i)); setF(c, a, bit(b, i)); }
  }
  // place data
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j; const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && k < out.length * 8) { mod[y][x] = bit(out[k >>> 3], 7 - (k & 7)); k++; }
    }
  }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
  const penalty = () => {
    let p = 0;
    const line = (get) => {
      let run = 1; let prev = get(0);
      for (let i = 1; i < size; i++) { const c = get(i); if (c === prev) run++; else { if (run >= 5) p += 3 + run - 5; run = 1; prev = c; } }
      if (run >= 5) p += 3 + run - 5;
      for (let i = 0; i + 11 <= size; i++) {
        const w = []; for (let j = 0; j < 11; j++) w.push(get(i + j) ? 1 : 0); const s = w.join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    };
    for (let y = 0; y < size; y++) line((i) => mod[y][i]);
    for (let x = 0; x < size; x++) line((i) => mod[i][x]);
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (mod[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) p += 3;
    }
    const tot = size * size; p += (Math.ceil(Math.abs(dark * 20 - tot * 10) / tot) - 1) * 10;
    return p;
  };
  let best = 0; let bestP = Infinity;
  for (let m = 0; m < 8; m++) { applyMask(m); drawFormat(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
  applyMask(best); drawFormat(best);
  return mod;
}
