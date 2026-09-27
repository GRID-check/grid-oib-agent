#!/usr/bin/env node
/**
 * Builds the founder portraits for the Team section from the originals.
 *
 *   node scripts/build-team-photos.mjs
 *
 * The three originals share nothing: a colour studio portrait at 1086×1448,
 * a black-and-white snapshot at 200×188, a colour photo outdoors at 200×200.
 * Set side by side they read as three different websites. So each is cropped
 * square with the head at a comparable scale, then all three get one
 * treatment: grey, levels normalised, mapped onto the site's olive ink and
 * paper as a two-colour (duotone) print.
 *
 * The output is 208 px square: twice the ~104 CSS px the section shows, and
 * no more. Two of the sources are 200 px, cropped to 170 to bring the head to
 * the studio portrait's scale; anything past 208 would only invent detail. Run it again after replacing an original; the
 * outputs are committed, the site does not run this at build time.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'team')
const SIZE = 208
// The duotone's two inks: the darkest the print gets, and the paper.
const INK = [0x2a, 0x2f, 0x1f]
const PAPER = [0xf6, 0xf5, 0xef]

// Square crops, in source pixels, chosen by eye so the head fills a similar
// share of each frame. The studio portrait is framed much tighter than the
// other two, so it takes its full width: that is as far out as it goes.
const PHOTOS = [
  { src: 'jonathan-uhlemann.jpg', out: 'jonathan-uhlemann.webp', left: 15, top: 0, size: 170 },
  { src: 'ferdinand-rubenbauer.jpg', out: 'ferdinand-rubenbauer.webp', left: 15, top: 0, size: 170 },
  { src: 'matthias-bigl.webp', out: 'matthias-bigl.webp', left: 0, top: 20, size: 1086 },
]

// One lookup table for all three: grey level → the colour between ink and
// paper. A slight gamma lift keeps the shadows from filling in, which a
// two-colour print does when the dark ink is this dark.
const lut = Array.from({ length: 256 }, (_, g) => {
  const t = (g / 255) ** 0.9
  return INK.map((ink, c) => Math.round(ink + (PAPER[c] - ink) * t))
})

mkdirSync(root, { recursive: true })
for (const p of PHOTOS) {
  const { data, info } = await sharp(join(root, 'originals', p.src))
    .extract({ left: p.left, top: p.top, width: p.size, height: p.size })
    .resize(SIZE, SIZE, { kernel: 'lanczos3' })
    .grayscale()
    .normalise({ lower: 1, upper: 99 })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const rgb = Buffer.alloc(info.width * info.height * 3)
  for (let i = 0; i < info.width * info.height; i++) {
    const [r, g, b] = lut[data[i * info.channels]]
    rgb[i * 3] = r
    rgb[i * 3 + 1] = g
    rgb[i * 3 + 2] = b
  }
  await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
    .webp({ quality: 86 })
    .toFile(join(root, p.out))
  console.log(`${p.out}: ${info.width}×${info.height}`)
}
