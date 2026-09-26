#!/usr/bin/env node
/**
 * Renders every brand raster from the one master mark, for both apps.
 *
 *   node scripts/build-brand-assets.mjs          write everything below
 *   node scripts/build-brand-assets.mjs --check  fail if an SVG copy drifted
 *
 * The master is `shared/brand/piloti-mark.svg`. Each app gets a committed copy,
 * because neither Docker build can see `shared/` (each builds from its own
 * directory). `npm run check` runs the `--check` form, so an edited copy, or a
 * master edited without re-running this, fails CI instead of shipping two marks.
 * The rasters are not compared: sharp's anti-aliasing moves between versions.
 *
 * Output
 *   frontends/web/public/  favicon.svg, favicon.ico, apple-touch-icon.png,
 *                          icons/icon-{192,512}.png, icons/icon-maskable-512.png,
 *                          og/default-{de,en}.png (interim share image)
 *   frontends/ui/src/app/  icon.svg, favicon.ico, apple-icon.png (Next file conventions)
 *   frontends/ui/public/   icons/icon-{192,512}.png, icons/icon-maskable-512.png
 *
 * Text in the share image is drawn as glyph outlines read from the site's own
 * WOFF2 fonts (fontkitten), so the render does not depend on the fonts the
 * machine happens to have installed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { create as openFont } from 'fontkitten'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(webRoot, '../..')
const uiRoot = resolve(repoRoot, 'frontends/ui')
const MASTER = resolve(repoRoot, 'shared/brand/piloti-mark.svg')

const INK = '#2a301f' // --color-accent-900, the tile
const LIME = '#a4d06a' // --color-accent-400
const PAPER = '#f7f7f3' // --color-canvas
const SAGE = '#5c6b42' // --color-accent-600

const SVG_COPIES = [
  resolve(webRoot, 'public/favicon.svg'),
  resolve(uiRoot, 'src/app/icon.svg'),
]

const master = readFileSync(MASTER, 'utf8')

if (process.argv.includes('--check')) {
  const drifted = SVG_COPIES.filter((path) => readFileSync(path, 'utf8') !== master)
  for (const path of drifted) {
    console.error(`${path} differs from ${MASTER}. Run node scripts/build-brand-assets.mjs.`)
  }
  if (drifted.length) process.exit(1)
  console.log('Brand mark copies match the master.')
  process.exit(0)
}

/** The mark's shapes without the rounded tile, for full-bleed and share renders. */
const markGroup = master.match(/<g id="mark">[\s\S]*?<\/g>/)?.[0]
if (!markGroup) throw new Error(`${MASTER} has no <g id="mark">`)

/** The mark on a square, unrounded ground; `scale` is the mark's share of the side. */
function fullBleed(scale) {
  const offset = (32 - 32 * scale) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${INK}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${markGroup}</g>
</svg>`
}

function png(svg, size) {
  return sharp(Buffer.from(svg), { density: (72 * size) / 32 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** An .ico holding PNG frames, which every browser since IE 11 reads. */
function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4) // colour planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...frames.map((f) => f.data)])
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  console.log(`wrote ${path.slice(repoRoot.length + 1)}`)
}

// ── Icons ──────────────────────────────────────────────────────────────────
const favicon = ico(
  await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(master, size) })))
)
// iOS rounds the corners itself and paints transparency black, so the touch
// icon is full-bleed and opaque. The maskable icon keeps the mark inside the
// 80% safe circle a launcher may crop to.
const touch = await sharp(await png(fullBleed(0.8), 180)).flatten({ background: INK }).png().toBuffer()
const manifestIcons = {
  'icons/icon-192.png': await png(master, 192),
  'icons/icon-512.png': await png(master, 512),
  'icons/icon-maskable-512.png': await png(fullBleed(0.6), 512),
}

for (const path of SVG_COPIES) write(path, master)
write(resolve(webRoot, 'public/favicon.ico'), favicon)
write(resolve(webRoot, 'public/apple-touch-icon.png'), touch)
write(resolve(uiRoot, 'src/app/favicon.ico'), favicon)
write(resolve(uiRoot, 'src/app/apple-icon.png'), touch)
for (const [name, data] of Object.entries(manifestIcons)) {
  write(resolve(webRoot, 'public', name), data)
  write(resolve(uiRoot, 'public', name), data)
}

// ── Interim share image (1200×630) ─────────────────────────────────────────
// Stands in until the riso print lands at public/art/og-piloti.png; see
// DEFAULT_OG_IMAGE in src/lib/seo.ts.
const font = (file) => openFont(readFileSync(resolve(webRoot, 'public/fonts', file)))
const fonts = {
  logo: font('poppins-500-latin.woff2'),
  voice: font('instrument-serif-400-latin.woff2'),
  mono: font('ibm-plex-mono-500-latin.woff2'),
}

/** Text as outline paths, left-aligned at (x, baseline y). No kerning: short lines only. */
function text(f, str, { x, y, size, fill, tracking = 0 }) {
  const scale = size / f.unitsPerEm
  let pen = x
  const paths = f.glyphsForString(str).map((glyph) => {
    const d = glyph.path.toSVG()
    const path = `<path transform="translate(${pen.toFixed(2)} ${y}) scale(${scale} ${-scale})" d="${d}"/>`
    pen += glyph.advanceWidth * scale + tracking * size
    return path
  })
  return `<g fill="${fill}">${paths.join('')}</g>`
}

const COPY = {
  de: {
    label: 'KI FÜR ARCHITEKTUR- UND PLANUNGSBÜROS',
    lines: ['Planen.', 'Statt suchen.'],
    foot: 'Baurecht · OIB-Richtlinien · Bürowissen — entwickelt in Wien',
  },
  en: {
    label: 'AI FOR ARCHITECTURE AND PLANNING FIRMS',
    lines: ['Plan.', 'Instead of searching.'],
    foot: 'Building law · OIB guidelines · office knowledge — built in Vienna',
  },
}

function ogSvg({ label, lines, foot }) {
  const grid = []
  for (let x = 0; x <= 1200; x += 40) grid.push(`<path d="M${x} 0V630"/>`)
  for (let y = 0; y <= 630; y += 40) grid.push(`<path d="M0 ${y}H1200"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <g stroke="#dcdfd8" stroke-width="1">${grid.join('')}</g>
  <g transform="translate(80 80) scale(3)">${master.replace(/<\?xml[^>]*>|<svg[^>]*>|<\/svg>|<title>[^<]*<\/title>|<!--[\s\S]*?-->/g, '')}</g>
  ${text(fonts.logo, 'PILOTI', { x: 200, y: 144, size: 44, fill: INK, tracking: 0.14 })}
  ${text(fonts.mono, label, { x: 80, y: 270, size: 22, fill: SAGE, tracking: 0.08 })}
  ${lines.map((line, i) => text(fonts.voice, line, { x: 76, y: 380 + i * 104, size: 112, fill: INK })).join('')}
  <rect x="80" y="548" width="1040" height="2" fill="${INK}"/>
  ${text(fonts.mono, foot, { x: 80, y: 590, size: 20, fill: SAGE })}
  <rect x="1064" y="580" width="56" height="10" fill="${LIME}"/>
</svg>`
}

for (const [locale, copy] of Object.entries(COPY)) {
  const og = await sharp(Buffer.from(ogSvg(copy))).png({ compressionLevel: 9 }).toBuffer()
  write(resolve(webRoot, `public/og/default-${locale}.png`), og)
}
