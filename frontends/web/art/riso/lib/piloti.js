/* ─────────────────────────────────────────────────────────────────────────────
   The Piloti series look, shared by every work: paper, inks, screen angles,
   registration, line specs, the one camera and the one sun, the parallel
   projection helpers, and the small props (1:100 figure, stakes).

   Classic script, loaded after engine.js. The values here ARE the series:
   change one and every plate of every work changes with it, so a change here
   means re-exporting every work (node art/riso/export.mjs) and looking at the
   result. A work that needs a different ink or camera for one plate passes
   its own values to that plate; it does not edit this file.

   Line weights, in 1080-unit drawing space (so they scale with the format):
     1.9  silhouettes      1.1–1.4  arrises      0.8–1.0  annotation
   A key line must stay >= ~1.25 device px, so a format far below 720 px wide
   (spot icons, email strips) needs its own composition with heavier units:
   units = 1.25 / K.
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

const PAPER = '#F4F2E8';

/* Real Riso drum colours (hex from the riso-colors list, M. DesLauriers, MIT).
   mist ≈ the site's sage tint, kelly ≈ its lime accent, moss + hunter overprint
   ≈ its dark olive panel and ink. red is spent once per plate at most. */
const INK = {
  mist:   '#D5E4C0',
  kelly:  '#67B346',
  moss:   '#68724D',
  hunter: '#407060',
  red:    '#F15060',
};
/* The drum each ink is on a Riso machine: what a print shop needs next to a separation. */
const INK_DRUM = {
  mist: 'Mist', kelly: 'Kelly Green', moss: 'Moss', hunter: 'Hunter Green', red: 'Bright Red',
};
/* Screen angles as rational tangents; each ink keeps its own lattice. */
const SCREEN = {
  mist:   { a: 1, b: 0 },   //  0.0°
  kelly:  { a: 1, b: 1 },   // 45.0°
  moss:   { a: 1, b: 4 },   // 76.0°
  hunter: { a: 4, b: 1 },   // 14.0°
  red:    { a: 2, b: 1 },   // 26.6°
};
/* Registration misses, in 1080-space device px; scaled by K and rounded, so a
   screened bitmap is never drawn at a sub-pixel offset (that would resample it). */
const REG = {
  mist:   [ 1.5, -1.0], kelly:  [-1.5,  1.5], moss:   [ 1.0,  1.5],
  hunter: [ 0.0,  0.0], red:    [-2.0,  1.0],
};

const KEY = { hunter: 1 };                 // key line
const KEY_DARK = { hunter: 1, moss: 0.85 };// overprinted line: darkest edge

/* ── geometry: parallel projection, shadows, hulls ─────────────────────────── */

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm: (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; },
};

/**
 * Axonometric camera. World metres: x east, y north, z up. ax/ay are the screen
 * angles of the x and y axes above horizontal (x to the right, y to the left),
 * fx/fy/fz their scale factors; s is units per metre, (ox, oy) the world origin
 * on the sheet. Parallel projection: every line in the world keeps its direction.
 */
function axo(o) {
  const ex = [Math.cos(o.ax) * o.fx, -Math.sin(o.ax) * o.fx];
  const ey = [-Math.cos(o.ay) * o.fy, -Math.sin(o.ay) * o.fy];
  const ez = [0, -o.fz];
  const P = (p) => [o.ox + o.s * (p[0] * ex[0] + p[1] * ey[0] + p[2] * ez[0]),
                    o.oy + o.s * (p[0] * ex[1] + p[1] * ey[1] + p[2] * ez[1])];
  P.ex = ex; P.ey = ey; P.ez = ez; P.s = o.s;
  // the world direction that projects to a point: the view ray, oriented into the sheet
  const r1 = [ex[0], ey[0], ez[0]], r2 = [ex[1], ey[1], ez[1]];
  let n = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  if (n[2] > 0) n = n.map((v) => -v);
  P.view = v3.norm(n);
  return P;
}
/**
 * Compose a view for a format: scale and place so the given world points fill
 * `fill` of the sheet's width or height (whichever binds first), centred at
 * (cx, cy) as fractions of the sheet. Linear projection, so one probe at s = 1.
 */
function fit(o, pts, f) {
  const probe = axo(Object.assign({}, o, { s: 1, ox: 0, oy: 0 }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { const q = probe(p); x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  const s = Math.min(W * f.fill / (x1 - x0), H * (f.fillH || f.fill) / (y1 - y0));
  return axo(Object.assign({}, o, { s, ox: W * f.cx - s * (x0 + x1) / 2, oy: H * f.cy - s * (y0 + y1) / 2 }));
}
/** Where a point's shadow lands on the plane z = z0, sun travelling along L. */
const onGround = (p, L, z0) => { const t = (p[2] - (z0 || 0)) / -L[2]; return [p[0] + L[0] * t, p[1] + L[1] * t, z0 || 0]; };

function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function pathOf(pts, closed = true) {
  const p = new Path2D();
  pts.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y));
  if (closed) p.closePath();
  return p;
}
/** World polygon → sheet path. */
const poly = (P, pts, closed = true) => pathOf(pts.map(P), closed);
/** Axis-aligned box faces seen from the -x, -y, +z side. */
function boxFaces(P, x0, y0, z0, x1, y1, z1) {
  return {
    top:   poly(P, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]),
    west:  poly(P, [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]]),
    south: poly(P, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]),
    sil:   pathOf(hull([[x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(P))),
  };
}
/** Silhouette of a vertical cylinder, and its left/right extreme x on the sheet. */
function cylinder(P, x, y, r, z0, z1) {
  const pts = [];
  for (let i = 0; i < 48; i++) { const a = i / 48 * TAU; pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
  const sheet = [];
  for (const [px, py] of pts) { sheet.push(P([px, py, z0]), P([px, py, z1])); }
  const hl = hull(sheet);
  let xl = Infinity, xr = -Infinity;
  for (const q of hl) { xl = Math.min(xl, q[0]); xr = Math.max(xr, q[0]); }
  const top = pathOf(pts.map(([px, py]) => P([px, py, z1])));
  const base = pts.map(([px, py]) => P([px, py, z0]));
  const front = base.filter((q) => q[1] >= P([x, y, z0])[1] - 0.01).sort((a, b) => a[0] - b[0]);
  return { sil: pathOf(hl), top, xl, xr, front, foot: P([x, y, z0]), head: P([x, y, z1]) };
}
/** Shadow of a vertical cylinder on the ground: a strip from its base. */
function cylShadow(P, x, y, r, h, L) {
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * TAU, bx = x + Math.cos(a) * r, by = y + Math.sin(a) * r;
    pts.push([bx, by, 0], onGround([bx, by, h], L));
  }
  return pathOf(hull(pts.map(P)));
}
const boxCorners = (x0, y0, z0, x1, y1, z1) => [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                                                [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
function boxShadow(P, corners, L, z0) { return pathOf(hull(corners.map((p) => P(onGround(p, L, z0))))); }

/* ── small shared props ────────────────────────────────────────────────────── */

/** Depth of a world point along the view direction: larger is further away. */
const depth = (P, p) => v3.dot(p, P.view);
/** A planar face is seen from its front when its normal points against the view. */
const facing = (P, n) => v3.dot(n, P.view) < 0;
/** Lambert term for a face normal under a sun travelling along L. */
const lit = (n, L) => clamp(-v3.dot(v3.norm(n), L), 0, 1);

/**
 * A 1:100 scale figure: weight on both feet, head tipped back to look up, a
 * rolled drawing under the near arm. Drawn on the sheet around its foot point,
 * so it stays upright in any parallel view; hpx is its height in units.
 */
function figure(foot, hpx, o) {
  o = o || {};
  const h = hpx, [fx, fy] = foot, back = o.back === undefined ? 0.03 : o.back;
  const hip = [fx - 0.004 * h, fy - 0.5 * h], sh = [fx - back * h, fy - 0.8 * h];
  const parts = [];
  parts.push(nib([[hip[0] - 0.035 * h, hip[1]], [fx - 0.05 * h, fy - 0.24 * h], [fx - 0.062 * h, fy]], (u) => 0.03 * h * (1 - 0.35 * u), { per: 6 }));
  parts.push(nib([[hip[0] + 0.035 * h, hip[1]], [fx + 0.045 * h, fy - 0.25 * h], [fx + 0.06 * h, fy]], (u) => 0.03 * h * (1 - 0.35 * u), { per: 6 }));
  parts.push(pathOf(curve([[hip[0] - 0.075 * h, hip[1] + 0.02 * h], [sh[0] - 0.105 * h, sh[1] + 0.02 * h], [sh[0] - 0.06 * h, sh[1] - 0.025 * h],
    [sh[0] + 0.06 * h, sh[1] - 0.025 * h], [sh[0] + 0.105 * h, sh[1] + 0.02 * h], [hip[0] + 0.075 * h, hip[1] + 0.02 * h]], true, 5)));
  parts.push(nib([[sh[0] - 0.012 * h, sh[1]], [sh[0] - 0.02 * h, sh[1] - 0.05 * h]], () => 0.022 * h, { raw: true }));   // neck
  // far arm hangs; near arm bent to hold the roll against the body
  parts.push(nib([[sh[0] - 0.095 * h, sh[1] + 0.01 * h], [sh[0] - 0.11 * h, fy - 0.62 * h], [sh[0] - 0.1 * h, fy - 0.43 * h]], (u) => 0.024 * h * (1 - 0.3 * u), { per: 6 }));
  parts.push(nib([[sh[0] + 0.095 * h, sh[1] + 0.01 * h], [sh[0] + 0.12 * h, fy - 0.64 * h], [sh[0] + 0.04 * h, fy - 0.6 * h]], (u) => 0.024 * h * (1 - 0.2 * u), { per: 6 }));
  const hc = [sh[0] - 0.035 * h, sh[1] - 0.11 * h], hr = 0.07 * h;
  const head = new Path2D(); head.ellipse(hc[0], hc[1], hr * 0.9, hr, -0.5, 0, TAU);
  parts.push(head);
  const body = new Path2D(); for (const p of parts) body.addPath(p);
  // the roll: a thin paper tube across the near elbow
  const r0 = [sh[0] - 0.02 * h, fy - 0.555 * h], r1 = [sh[0] + 0.3 * h, fy - 0.7 * h];
  const roll = nib([r0, r1], () => 0.022 * h, { raw: true });
  const rollEnd = new Path2D(); rollEnd.ellipse(r1[0], r1[1], 0.012 * h, 0.022 * h, -0.4, 0, TAU);
  return { body, roll, rollEnd, top: [hc[0], hc[1] - hr] };
}

/* One camera and one sun for the whole series: x nearly level, y receding up-left
   at half scale, z true; a low sun from the front-left. */
const VIEW_SERIES = { ax: 0.05, ay: 0.64, fx: 1, fy: 0.52, fz: 1 };
const SUN_SERIES = v3.norm([0.74, 0.52, -0.62]);

/** A surveyor's stake: a thin square post, lit on its west face. Returns its top on the sheet. */
function stake(c, P, x, y, h, o) {
  o = o || {};
  const r = o.r || 0.045;
  const f = boxFaces(P, x - r, y - r, 0, x + r, y + r, h);
  own(c, f.west, {});
  own(c, f.south, { moss: 0.55 });
  line(c, f.sil, o.w || 1.0, KEY);
  return P([x, y, h]);
}
/** Setting-out: stakes at the corners of a plan rectangle, strings between them, the line dashed on the ground. */
function settingOut(c, P, x0, y0, x1, y1, o) {
  o = o || {};
  const hs = o.h || 0.9, hz = o.string || 0.55;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  dashed(c, poly(P, corners.map(([x, y]) => [x, y, 0])), 1.2, { hunter: 0.8 }, [5, 5]);
  const back = corners.slice().sort((a, b) => depth(P, [b[0], b[1], 0]) - depth(P, [a[0], a[1], 0]));
  const str = poly(P, corners.map(([x, y]) => [x, y, hz]));
  for (const [x, y] of back.slice(0, 2)) stake(c, P, x, y, hs, o);
  line(c, str, 0.8, { hunter: 0.9 });
  for (const [x, y] of back.slice(2)) stake(c, P, x, y, hs, o);
}
