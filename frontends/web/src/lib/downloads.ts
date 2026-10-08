/**
 * Every riso file, as the unlisted image page (`DOWNLOADS_SLUG`) lists it and
 * its ZIP endpoint packs it. Nothing here is a hand list: the items come from
 * the two generated manifests,
 *
 *   src/data/art.json        the files the site shows (public/art/)
 *   src/data/downloads.json  the out and app files it shows nowhere
 *                            (public/downloads/, art/riso/downloads.mjs)
 *
 * so a new plate, format or work appears with the export that made it. One
 * item per plate (`<work>/<plate>`), carrying every file of every format
 * exported for it: each density, the on-page twin, the print separations.
 *
 * The app's manifest (frontends/ui/src/lib/art/art.json) is not read here: the
 * site's image is built from frontends/web alone, so downloads.mjs copies the
 * app's files and their entries into the downloads manifest instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import siteManifest from '../data/art.json'
import downloadsManifest from '../data/downloads.json'
import type { Locale } from '../i18n/ui'
import { DOWNLOADS_SLUG } from './unlisted'

interface ManifestFile {
  density: number
  src: string
  width: number
  height: number
}

interface ManifestEntry {
  work: string
  plate: string
  format: string
  numeral: string | null
  width: number
  height: number
  alt: Record<Locale, string> | null
  caption?: Record<Locale, string>
  files: ManifestFile[]
  page?: ManifestFile[]
  separations?: {
    sheet: string
    inks: { order: number; ink: string; drum: string; hex: string; src: string; width: number; height: number }[]
  }
}

const SITE: Record<string, ManifestEntry> = siteManifest.art
const DOWNLOADS: Record<string, ManifestEntry> = downloadsManifest.art

export type FileVariant = 'paper' | 'page' | 'separation' | 'sheet'

export interface DownloadFile {
  /** URL with its `?v=` content hash. */
  href: string
  /** Path under `public/` (and `dist/client/`). */
  path: string
  /** Name to save it under, and its name inside a ZIP. */
  name: string
  format: string
  variant: FileVariant
  /** The ink of a separation. */
  ink?: string
  width: number
  height: number
  type: 'WebP' | 'PNG' | 'JPEG' | 'JSON'
}

export interface Preview {
  src: string
  srcset?: string
  /** CSS size: the 1x file's own, or exactly half of it. */
  width: number
  height: number
  onPage: boolean
}

export interface DownloadItem {
  key: string
  work: string
  plate: string
  numeral: string | null
  caption: Record<Locale, string> | null
  alt: Record<Locale, string> | null
  preview: Preview
  files: DownloadFile[]
}

export interface DownloadGroup {
  work: string
  items: DownloadItem[]
}

/**
 * Formats in the order a plate's files are listed, and the first one present
 * is the item's preview. A format not named here (a new one) comes last.
 */
const FORMAT_ORDER = ['plate', 'cover', 'release', 'empty', 'spot', 'email', 'og', 'banner', 'social', 'linkedin', 'deck', 'postcard']
/** Works in page order; a work not named here follows, by name. */
const WORK_ORDER = ['tafeln', 'tragwerk', 'releases', 'vignetten', 'collateral']
/** A preview wider than this is shown at exactly half its size (never another scale: moiré). */
const NATIVE_MAX = 400

/** `social-titel` is a `social` job with its own plate name; the format is the stem. */
export const formatKey = (format: string) => format.split('-')[0]
const rank = (list: string[], key: string) => (list.includes(key) ? list.indexOf(key) : list.length)
const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10 }
const romanValue = (n: string) =>
  [...n].reduce((sum, c, i) => sum + (ROMAN[c] < (ROMAN[n[i + 1]] ?? 0) ? -ROMAN[c] : ROMAN[c]), 0)

const pathOf = (src: string) => src.replace(/\?.*$/, '')
const TYPES: Record<string, DownloadFile['type']> = { webp: 'WebP', png: 'PNG', jpg: 'JPEG', json: 'JSON' }
const extOf = (src: string) => path.extname(pathOf(src)).slice(1)

/** `piloti-<work>[-<numeral>]-<plate>-<format>-<w>x<h>[-transparent].<ext>` */
function fileName(e: ManifestEntry, f: { width: number; height: number; src: string }, suffix = '') {
  const parts = ['piloti', e.work, e.numeral?.toLowerCase(), e.plate, e.format, `${f.width}x${f.height}`]
  return `${parts.filter(Boolean).join('-')}${suffix}.${extOf(f.src)}`
}

function filesOf(e: ManifestEntry): DownloadFile[] {
  const file = (f: ManifestFile, variant: FileVariant, suffix = ''): DownloadFile => ({
    href: f.src,
    path: pathOf(f.src),
    name: fileName(e, f, suffix),
    format: e.format,
    variant,
    width: f.width,
    height: f.height,
    type: TYPES[extOf(f.src)],
  })
  const out = [...e.files.map((f) => file(f, 'paper')), ...(e.page ?? []).map((f) => file(f, 'page', '-transparent'))]
  const seps = e.separations
  if (!seps) return out
  for (const ink of seps.inks) {
    out.push({ ...file({ ...ink, density: 1 }, 'separation', `-sep-${ink.order}-${ink.ink}`), ink: ink.ink })
  }
  // the print shop's sheet (drums, hex, order); a JSON file has no pixel size
  const sheet = file({ src: seps.sheet, width: e.width, height: e.height, density: 1 }, 'sheet', '-separations')
  out.push({ ...sheet, width: 0, height: 0 })
  return out
}

function previewOf(e: ManifestEntry): Preview {
  const files = e.page ?? e.files
  const lo = files.find((f) => f.density === 1) ?? files[0]
  const hi = files.find((f) => f.density === 2)
  if (lo.width <= NATIVE_MAX) {
    return { src: lo.src, srcset: hi ? `${lo.src} 1x, ${hi.src} 2x` : undefined, width: lo.width, height: lo.height, onPage: !!e.page }
  }
  // Half size: the 1x file, one image pixel per device pixel on a 2x screen.
  return { src: lo.src, width: lo.width / 2, height: lo.height / 2, onPage: !!e.page }
}

function itemsOf(entries: ManifestEntry[]): DownloadItem[] {
  const byPlate = new Map<string, ManifestEntry[]>()
  for (const e of entries) {
    const key = `${e.work}/${e.plate}`
    byPlate.set(key, [...(byPlate.get(key) ?? []), e])
  }
  const items = [...byPlate.entries()].map(([key, list]) => {
    list.sort((a, b) => rank(FORMAT_ORDER, formatKey(a.format)) - rank(FORMAT_ORDER, formatKey(b.format)))
    const first = list[0]
    return {
      key,
      work: first.work,
      plate: first.plate,
      numeral: list.find((e) => e.numeral)?.numeral ?? null,
      caption: list.find((e) => e.caption)?.caption ?? null,
      alt: list.find((e) => e.alt)?.alt ?? null,
      preview: previewOf(first),
      files: list.flatMap(filesOf),
    }
  })
  return items.sort(
    (a, b) =>
      (a.numeral ? romanValue(a.numeral) : 999) - (b.numeral ? romanValue(b.numeral) : 999) ||
      a.plate.localeCompare(b.plate),
  )
}

/** Every riso file, grouped by work, in page order. */
export function downloadGroups(): DownloadGroup[] {
  const entries = [...Object.values(SITE), ...Object.values(DOWNLOADS)]
  const works = [...new Set(entries.map((e) => e.work))].sort(
    (a, b) => rank(WORK_ORDER, a) - rank(WORK_ORDER, b) || a.localeCompare(b),
  )
  return works.map((work) => ({ work, items: itemsOf(entries.filter((e) => e.work === work)) }))
}

// ── the ZIPs ────────────────────────────────────────────────────────────────

/** The archive of everything; every other archive is one work. */
export const ALL_ARCHIVE = 'alle'

export const archiveHref = (archive: string) => `/${DOWNLOADS_SLUG}/${archive}.zip`
export const archiveName = (archive: string) =>
  archive === ALL_ARCHIVE ? 'piloti-bildmaterial.zip' : `piloti-bildmaterial-${archive}.zip`

/** The files of an archive, with their path inside it, or null for no such archive. */
export function archiveEntries(archive: string): { path: string; href: string; name: string }[] | null {
  const groups = downloadGroups().filter((g) => archive === ALL_ARCHIVE || g.work === archive)
  if (!groups.length) return null
  return groups.flatMap((g) =>
    g.items.flatMap((i) => i.files.map((f) => ({ path: f.path, href: f.href, name: `piloti-bildmaterial/${g.work}/${f.name}` }))),
  )
}

/**
 * Where the files lie: `dist/client/` beside the built server (whose chunks
 * sit under `dist/server/`), else `public/` (astro dev, and the build's own
 * prerender, which runs in the project root).
 */
export function publicRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 5; up++) {
    if (path.basename(dir) === 'server' && fs.existsSync(path.join(dir, '..', 'client', 'art'))) {
      return path.join(dir, '..', 'client')
    }
    dir = path.dirname(dir)
  }
  return path.join(process.cwd(), 'public')
}

/** Bytes of a file under the public root. */
export const bytesOf = (file: string, root = publicRoot()) => fs.statSync(path.join(root, file)).size
