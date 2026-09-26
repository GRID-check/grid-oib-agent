/* ─────────────────────────────────────────────────────────────────────────────
   Piloti riso print engine. Shared by every work in art/riso/<work>/index.html.

   A classic script (not a module): the kit's tools open a work over file://,
   where module scripts are blocked and classic scripts load. Top-level
   declarations here are shared with the work's own inline script, which is how
   a plate's draw() reads W, H, K, CX, CY and calls own(), line(), hatch() ...

   Adapted from riso-windowseat (MIT, (c) 2026 sevenevesai), prints/workings
   and prints/cabinet, pinned in art/riso/kit.json; LICENSE-NOTICE.md in
   art/riso/ carries the licence. Changes from the kit: non-square formats,
   per-job pitch, a solid line layer per ink, integer registration offsets,
   starvation placed in drawing units, a JOBS table built from formats.js, and
   a separation view for press work.

   Load order in a work: formats.js, engine.js, piloti.js, then the work.

   Query string views (any work):
     ?t=<job>      which job to show
     ?only=<ink>   bake a single ink, on paper, in colour (debug)
     ?sep=<ink>    press separation: that ink's screened plate, black on white,
                   no paper, no registration offset (export.mjs uses it)
     ?debug=lines  construction lines, where a plate implements them
     ?list         bake nothing; publish window.__riso.jobs only
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

const QS = new URLSearchParams(location.search);
const ONLY = QS.get('only');
const SEP = QS.get('sep');
const DEBUG = QS.get('debug') || '';

/* Every format is drawn in a 1080-unit wide space. H is the format's height in
   units. OUT/OUTH/K/PITCH are set per job before a bake. */
const W = 1080;
let H = 1080, CX = 540, CY = 540;
let OUT = 1080, OUTH = 1080, K = 1, PITCH = 4.6;

/* ── deterministic randomness ─────────────────────────────────────────────── */

function mulberry32(a) {
  return function () {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const rngFor = (key) => mulberry32(hash(key));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const TAU = Math.PI * 2;

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/* ── halftone screens (kit, with Cabinet's pixel-centred dots) ───────────── */

const screens = {};
function buildScreen(name) {
  const { a, b } = SCREEN[name];
  const n = a * a + b * b;
  const S = Math.max(2, Math.round(PITCH * Math.sqrt(n)));
  const P = S / Math.sqrt(n);
  const u = P / Math.sqrt(n);
  const v1 = [u * a, u * b], v2 = [-u * b, u * a];
  const pts = [];
  for (let m = -n; m <= n; m++) {
    for (let k = -n; k <= n; k++) {
      const x = m * v1[0] + k * v2[0], y = m * v1[1] + k * v2[1];
      // +0.5 puts dot centres on pixel centres, so the smallest dots grow 1 → 5 → 9 px
      const wx = ((x % S) + S + 0.5) % S, wy = ((y % S) + S + 0.5) % S;
      if (!pts.some(p => Math.abs(p[0] - wx) < 0.01 && Math.abs(p[1] - wy) < 0.01)) pts.push([wx, wy]);
    }
  }
  const wrapped = [];
  for (const [x, y] of pts) for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) wrapped.push([x + dx, y + dy]);
  const th = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d2 = Infinity;
      for (const [px, py] of wrapped) {
        const dx = x + 0.5 - px, dy = y + 0.5 - py, q = dx * dx + dy * dy;
        if (q < d2) d2 = q;
      }
      th[y * S + x] = clamp(Math.PI * d2 / (P * P), 0, 1);
    }
  }
  return { S, th };
}
const screenOf = (name) => {
  const key = name + '@' + PITCH;
  return screens[key] || (screens[key] = buildScreen(name));
};

const DITHER = (() => { const r = mulberry32(0x5eed), a = new Float32Array(65536); for (let i = 0; i < a.length; i++) a[i] = r(); return a; })();

/** Screen a tone layer to hard dots and union a solid line layer onto it. */
function screenPlate(tone, line, name) {
  const sc = screenOf(name);
  const w = tone.width, h = tone.height;
  const src = tone.getContext('2d').getImageData(0, 0, w, h), s = src.data;
  const ln = line.getContext('2d').getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) {
    const row = (y % sc.S) * sc.S;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const cover = s[i + 3] / 255;
      const c = cover + (DITHER[(y & 255) * 256 + (x & 255)] - 0.5) * 0.09 * Math.min(1, cover * 10) * (1 - cover);
      const dot = c >= 1 || c > sc.th[row + (x % sc.S)] ? 255 : 0;
      // Line work is not screened: a stroke thinner than the pitch would break into
      // dots. Its antialiased edge is kept, as a scan of a solid printed line shows.
      s[i + 3] = Math.max(dot, ln[i + 3]);
    }
  }
  const out = cv(w, h);
  out.getContext('2d').putImageData(src, 0, 0);
  return out;
}

/* ── paper (kit), drawn in units so every size of a plate is one sheet ───── */

function bakePaper() {
  const c = cv(OUT, OUTH), x = c.getContext('2d');
  x.setTransform(K, 0, 0, K, 0, 0);
  x.fillStyle = PAPER; x.fillRect(0, 0, W, H);
  const r = rngFor('paper');
  for (const [res, maxA] of [[30, 0.09], [72, 0.065], [165, 0.045]]) {
    const rh = Math.max(2, Math.round(res * H / W));
    const n = cv(res, rh), nx = n.getContext('2d');
    const img = nx.createImageData(res, rh);
    for (let i = 0; i < res * rh; i++) {
      img.data[i * 4] = 0xB4; img.data[i * 4 + 1] = 0xA6; img.data[i * 4 + 2] = 0x8C;
      img.data[i * 4 + 3] = Math.pow(r(), 1.8) * 255 * maxA;
    }
    nx.putImageData(img, 0, 0);
    x.save();
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(n, 0, 0, W, H);
    x.restore();
  }
  x.save();
  x.strokeStyle = '#8a7f6a';
  for (let i = 0; i < Math.round(420 * H / W); i++) {
    const px = r() * W, py = r() * H, len = 5 + r() * 22, ang = r() * Math.PI;
    x.globalAlpha = 0.008 + r() * 0.016;
    x.lineWidth = 0.5 + r() * 0.7;
    x.beginPath();
    x.moveTo(px, py);
    x.quadraticCurveTo(px + Math.cos(ang) * len * 0.5 + (r() - 0.5) * 5,
                       py + Math.sin(ang) * len * 0.5 + (r() - 0.5) * 5,
                       px + Math.cos(ang) * len, py + Math.sin(ang) * len);
    x.stroke();
  }
  x.restore();
  x.save();
  for (let i = 0; i < Math.round(2200 * H / W); i++) {
    x.globalAlpha = 0.012 + r() * 0.03;
    x.fillStyle = r() < 0.55 ? '#7d7362' : '#ffffff';
    x.beginPath();
    x.arc(r() * W, r() * H, 0.4 + r() * 1.0, 0, TAU);
    x.fill();
  }
  x.restore();
  return c;
}

/** Ink starvation: flecks dropped out of the tone layer, placed in units. */
function starve(g, rng) {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  const n = Math.round(1188 * H / W);
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.2 + rng() * 0.55;
    g.beginPath();
    g.arc(rng() * W, rng() * H, 0.5 + rng() * 2.0, 0, TAU);
    g.fill();
  }
  g.restore();
}

/* ── craft kit (subset, from the kit's craft block) ──────────────────────── */

function makeWob(rng, harmonics = 3) {
  const h = [];
  for (let i = 0; i < harmonics; i++) h.push([2 + i, rng() * 2 - 1, rng() * TAU]);
  return (th) => h.reduce((s, [k, a, p]) => s + a * Math.sin(k * th + p), 0) / harmonics;
}
const tone = (g, a) => { g.globalAlpha = clamp(a, 0, 1); };

function curve(pts, closed, per) {
  per = per || 12;
  const n = pts.length, out = [];
  const at = (i) => pts[closed ? (i + n * 2) % n : clamp(i, 0, n - 1)];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < per; k++) {
      const u = k / per, u2 = u * u, u3 = u2 * u;
      out.push([
        0.5 * (2 * p1[0] + (p2[0] - p0[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2
               + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * u3),
        0.5 * (2 * p1[1] + (p2[1] - p0[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2
               + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * u3),
      ]);
    }
  }
  if (!closed) out.push(pts[n - 1].slice());
  return out;
}
function nib(pts, wfn, o) {
  o = o || {};
  const c = o.raw ? pts : curve(pts, false, o.per || 10);
  const n = c.length, L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const m = Math.hypot(tx, ty) || 1; tx /= m; ty /= m;
    const w = Math.max(0.01, wfn(i / (n - 1)));
    L.push([c[i][0] - ty * w, c[i][1] + tx * w]);
    R.push([c[i][0] + ty * w, c[i][1] - tx * w]);
  }
  const p = new Path2D();
  p.moveTo(L[0][0], L[0][1]);
  for (let i = 1; i < n; i++) p.lineTo(L[i][0], L[i][1]);
  for (let i = n - 1; i >= 0; i--) p.lineTo(R[i][0], R[i][1]);
  p.closePath();
  return p;
}
function print(g, path, a) { tone(g, a === undefined ? 1 : a); g.fill(path); }
function carve(g, path) {
  g.save();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'destination-out';
  g.fill(path);
  g.restore();
}
function shade(g, path, o) {
  g.save();
  if (path) g.clip(path);
  const grd = o.r !== undefined
    ? g.createRadialGradient(o.x, o.y, o.r0 || 0, o.x, o.y, o.r)
    : g.createLinearGradient(o.x0, o.y0, o.x1, o.y1);
  for (const [at, a] of o.stops) grd.addColorStop(clamp(at, 0, 1), 'rgba(0,0,0,' + clamp(a, 0, 1) + ')');
  if (o.cut) g.globalCompositeOperation = 'destination-out';
  g.globalAlpha = 1;
  g.fillStyle = grd;
  g.fillRect(-W, -W, W * 3, W * 3);
  g.restore();
}
function hatch(g, path, rng, o) {
  o = o || {};
  const gap = o.gap || 10, span = W * 1.6;
  const w = o.w || 2.2, a = o.a === undefined ? 1 : o.a;
  g.save();
  if (path) g.clip(path);
  if (o.cut) g.globalCompositeOperation = 'destination-out';
  g.translate(CX, CY); g.rotate(o.ang === undefined ? -0.5 : o.ang); g.translate(-CX, -CY);
  g.lineCap = 'round';
  const n = Math.ceil(span * 2 / gap);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1), f = o.fade ? clamp(o.fade(u), 0, 1) : 1;
    if (f <= 0.02) continue;
    g.globalAlpha = a * f;
    g.lineWidth = w * (0.72 + rng() * 0.5) * clamp(f, 0.3, 1);
    const y = CY - span + i * gap + (rng() - 0.5) * gap * 0.3;
    g.beginPath();
    for (let k = 0; k <= 7; k++) {
      const x = CX - span + span * 2 * k / 7, yy = y + (rng() - 0.5) * 2.4;
      k ? g.lineTo(x, yy) : g.moveTo(x, yy);
    }
    g.stroke();
  }
  g.restore();
}
function spray(g, path, rng, o) {
  o = o || {};
  const n = o.n || 900, r0 = o.r0 || 0.8, r1 = o.r1 || 3.0;
  const b = o.box || [0, 0, W, H], a = o.a === undefined ? 1 : o.a;
  g.save();
  if (o.cut) g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) {
    const x = b[0] + rng() * b[2], y = b[1] + rng() * b[3];
    const d = o.density ? o.density(x, y) : 1;
    const keep = rng() < d, rr = r0 + rng() * (r1 - r0), av = 0.45 + rng() * 0.55;
    if (!keep || (path && !g.isPointInPath(path, x, y))) continue;
    g.globalAlpha = a * av;
    g.beginPath();
    g.arc(x, y, rr, 0, TAU);
    g.fill();
  }
  g.restore();
}

/* ── plate context: a tone layer (screened) and a line layer (solid) per ink ──
   c.g is tone, c.L is line. A spec maps ink → tone, e.g. { moss: .4, hunter: .2 }.
   Painter's order holds on both layers: own() clears tone and line beneath a
   shape, so an occluder hides the lines behind it as well as the fields.     */

function own(c, path, spec) {
  carve(c.g, path); carve(c.L, path);
  const a = spec && spec[c.ink];
  if (a) print(c.g, path, a);
}
function tint(c, path, spec) { const a = spec[c.ink]; if (a) print(c.g, path, a); }
function clearAll(c, path) { carve(c.g, path); carve(c.L, path); }
function line(c, path, w, spec) {
  const a = spec[c.ink];
  if (!a) return;
  c.L.save();
  c.L.globalAlpha = clamp(a, 0, 1);
  c.L.lineWidth = w;
  c.L.stroke(path);
  c.L.restore();
}
function lineFill(c, path, spec) {
  const a = spec[c.ink];
  if (!a) return;
  c.L.save(); c.L.globalAlpha = clamp(a, 0, 1); c.L.fill(path); c.L.restore();
}
/** Dashed line, dashes in units. */
function dashed(c, path, w, spec, dash) {
  const a = spec[c.ink];
  if (!a) return;
  c.L.save();
  c.L.setLineDash(dash || [7, 5]);
  c.L.lineCap = 'butt';
  c.L.globalAlpha = a; c.L.lineWidth = w; c.L.stroke(path);
  c.L.restore();
}

/* ── plate numbers: engraved roman capitals (Cabinet's numeral) ──────────── */

/** 1 → 'I' … 39 → 'XXXIX'; the glyphs below draw I, V and X. */
function roman(n) {
  const units = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
  if (!(n >= 1 && n <= 39 && n === Math.floor(n))) throw Error(`plate number ${n}: numerals run 1..39`);
  return 'X'.repeat(Math.floor(n / 10)) + units[n % 10];
}

function numeral(n, cx, base, h) {
  const glyphs = [], romans = roman(n);
  const thick = h * 0.13, thin = h * 0.045, sw = h * 0.2;
  const adv = { I: h * 0.36, V: h * 0.78, X: h * 0.74 }, total = [...romans].reduce((s, c) => s + adv[c], 0) + (romans.length - 1) * h * 0.1;
  let x = cx - total / 2;
  const stem = (x0, y0, x1, y1, w) => nib([[x0, y0], [x1, y1]], u => w * (1 + 0.25 * Math.pow(Math.abs(u - 0.5) * 2, 6)), { raw: true });
  const serif = (x0, y, len) => nib([[x0 - len, y], [x0 + len, y]], u => thin * (0.6 + 0.8 * Math.pow(Math.abs(u - 0.5) * 2, 3)), { raw: true });
  for (const c of romans) {
    if (c === 'I') {
      const m = x + adv.I / 2;
      glyphs.push(stem(m, base - h, m, base, thick / 2), serif(m, base - h + thin / 2, sw), serif(m, base - thin / 2, sw));
    } else if (c === 'V') {
      const l = x + h * 0.08, r = x + adv.V - h * 0.08, m = (l + r) / 2;
      glyphs.push(stem(l, base - h, m, base, thick / 2), stem(r, base - h, m, base, thin / 2),
                  serif(l, base - h + thin / 2, sw * 0.9), serif(r, base - h + thin / 2, sw * 0.7));
    } else {
      // X: the thick stroke falls left to right, as in V; serifs at all four ends.
      const l = x + h * 0.08, r = x + adv.X - h * 0.08;
      glyphs.push(stem(l, base - h, r, base, thick / 2), stem(r, base - h, l, base, thin / 2),
                  serif(l, base - h + thin / 2, sw * 0.8), serif(r, base - h + thin / 2, sw * 0.7),
                  serif(l, base - thin / 2, sw * 0.7), serif(r, base - thin / 2, sw * 0.8));
    }
    x += adv[c] + h * 0.1;
  }
  return glyphs;
}

/* ── runtime: a work's JOBS table, the bake, and the kit's __riso contract ──

   A work calls Riso.run({ work, plates, jobs }) once, at the end of its script:

     plates: [{ name: 'stuetzen', base: 'piloti-i-stuetzen', art: I, composes: ['sq'], number?: 1 }]
       name    the plate's stable key. It seeds every random stream of the plate
               (name:compose:ink), so renaming it reseeds the print. Freeze it.
       base    file name stem; defaults to '<work>-<name>'
       art     { inks, key, draw(c, compose), numeral?: { <compose>: [x, y] } }
       composes the compositions draw() handles; a job asking for another fails
       number  its roman numeral, default its 1-based position; 0 draws none

     jobs: [{ plate, format, alt: { de, en }, caption?: { de, en }, compose?, id? }]
       format  a key of FORMATS (formats.js); it brings sizes, pitch, encoding,
               destination and the default composition
       alt     required for formats with dest 'site' (they reach the manifest)
       id      default '<work>/<plate>/<format>'; pages use it, never a path

   Each job expands to one export per size of its format, so the integer time t
   picks one file: window.__riso.jobs[t]. seek(t) is pure; bakes are cached. */

const Riso = (() => {
  const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (_, k) => {
    if (v[k] === undefined) throw Error(`file template ${tpl}: no value for {${k}}`);
    return String(v[k]);
  });

  function expand(spec) {
    if (!spec.work || !/^[a-z0-9][a-z0-9-]*$/.test(spec.work)) throw Error(`work "${spec.work}": lowercase letters, digits and hyphens`);
    const plates = new Map();
    spec.plates.forEach((p, i) => {
      if (plates.has(p.name)) throw Error(`plate "${p.name}" declared twice`);
      if (!p.art || typeof p.art.draw !== 'function') throw Error(`plate "${p.name}": art.draw missing`);
      plates.set(p.name, Object.assign({ base: `${spec.work}-${p.name}`, number: i + 1 }, p));
    });
    const jobs = [], arts = [], ids = new Set();
    for (const d of spec.jobs) {
      const pl = plates.get(d.plate), f = FORMATS[d.format];
      if (!pl) throw Error(`job ${JSON.stringify(d.plate)}: no such plate`);
      if (!f) throw Error(`job ${d.plate}: no format "${d.format}" in formats.js`);
      const compose = d.compose || f.compose;
      const composes = pl.composes || pl.art.composes;
      if (composes && !composes.includes(compose)) throw Error(`plate ${d.plate} has no composition "${compose}" (it draws ${composes.join(', ')})`);
      const id = d.id || `${spec.work}/${d.plate}/${d.format}`;
      if (ids.has(id)) throw Error(`art id "${id}" declared twice; give one an explicit id`);
      ids.add(id);
      if (f.dest === 'site' && !(d.alt && d.alt.de && d.alt.en)) throw Error(`${id}: a site asset needs alt text in de and en`);
      if (d.caption && !(d.caption.de && d.caption.en)) throw Error(`${id}: a caption needs de and en`);
      for (const s of f.sizes) {
        jobs.push({
          id, work: spec.work, plate: d.plate, format: d.format, compose,
          number: f.numeral === false ? 0 : pl.number,
          density: s.density, w: s.w, h: s.h, pitch: s.pitch,
          file: fill(f.file, { base: pl.base, w: s.w, h: s.h }) + '.' + f.encode,
          encode: f.encode, dest: f.dest, separations: !!f.separations,
          inks: pl.art.inks.slice(), alt: d.alt || null, caption: d.caption || null,
        });
        arts.push(pl.art);
      }
    }
    return { jobs, arts };
  }

  function setJob(j) {
    OUT = j.w; OUTH = j.h; K = OUT / W; H = W * OUTH / OUT; CX = W / 2; CY = H / 2; PITCH = j.pitch;
  }

  function bake(j, pl) {
    setJob(j);
    const out = cv(OUT, OUTH), o = out.getContext('2d');
    if (SEP) { o.fillStyle = '#fff'; o.fillRect(0, 0, OUT, OUTH); } else o.drawImage(bakePaper(), 0, 0);
    const tone = cv(OUT, OUTH), g = tone.getContext('2d');
    const lineC = cv(OUT, OUTH), L = lineC.getContext('2d');
    const scratch = cv(OUT, OUTH).getContext('2d');
    const na = (pl.numeral && pl.numeral[j.compose]) || [W / 2, H - 22];
    const nums = j.number ? numeral(j.number, na[0], na[1], 17) : [];
    for (const ink of pl.inks) {
      if (ONLY && ink !== ONLY) continue;
      if (SEP && ink !== SEP) continue;
      for (const x of [g, L]) {
        x.setTransform(K, 0, 0, K, 0, 0);
        x.clearRect(0, 0, W, H);
        x.globalAlpha = 1;
        x.globalCompositeOperation = 'source-over';
        x.fillStyle = x.strokeStyle = '#000';
        x.lineCap = 'round';
        x.lineJoin = 'round';
      }
      const c = { g, L, ink, scratch, rng: rngFor(j.plate + ':' + j.compose + ':' + ink), sr: rngFor(j.plate + ':' + j.compose + ':shape') };
      g.save(); L.save();
      pl.draw(c, j.compose);
      g.restore(); L.restore();
      if (ink === pl.key) { for (const p of nums) { L.save(); L.fill(p); L.restore(); } }
      starve(g, rngFor(j.plate + ':' + ink + ':void'));
      const dots = screenPlate(tone, lineC, ink);
      // A separation is the screened plate itself, registered: the press adds its own miss.
      if (SEP) { o.drawImage(dots, 0, 0); continue; }
      const tin = cv(OUT, OUTH), tx = tin.getContext('2d');
      tx.drawImage(dots, 0, 0);
      tx.globalCompositeOperation = 'source-in';
      tx.fillStyle = INK[ink];
      tx.fillRect(0, 0, OUT, OUTH);
      const [rx, ry] = REG[ink];
      o.save();
      o.globalCompositeOperation = 'multiply';
      o.drawImage(tin, Math.round(rx * K * 0.7), Math.round(ry * K * 0.7));
      o.restore();
    }
    return out;
  }

  /** A work that cannot run still answers the contract, so tools fail at once with the reason. */
  function refuse(e) {
    const msg = 'riso work error: ' + (e && e.message || e);
    console.error(msg);
    const cap = document.getElementById('cap');
    if (cap) cap.textContent = msg;
    window.__riso = { duration: 0, ready: true, seek() {}, jobs: [], error: msg };
  }

  function run(spec) {
    let jobs, arts;
    try { ({ jobs, arts } = expand(spec)); } catch (e) { refuse(e); return; }
    const canvas = document.getElementById('c'), ctx = canvas.getContext('2d');
    const baked = new Map();
    const clampJob = (t) => clamp(Math.floor(t + 1e-6), 0, jobs.length - 1);
    function render(t) {
      const ji = clampJob(t);
      if (!baked.has(ji)) baked.set(ji, bake(jobs[ji], arts[ji]));
      const img = baked.get(ji);
      if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(img, 0, 0);
      document.getElementById('cap').textContent = `${ji}  ${jobs[ji].id}  ${jobs[ji].file}${SEP ? '  sep:' + SEP : ''}`;
    }
    const DUR = jobs.length;
    function seek(t) { render(clamp(t, 0, DUR)); }
    window.__riso = { duration: DUR, ready: false, seek, jobs, work: spec.work };
    if (!QS.has('list')) seek(Number(QS.get('t')) || 0);
    window.__riso.ready = true;
  }

  return { run, expand, roman };
})();
