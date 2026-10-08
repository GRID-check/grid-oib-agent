/**
 * A ZIP dropped on a shelf is a folder that has not been unpacked yet.
 *
 * So it is unpacked here, in the browser, into the shape a dropped folder
 * already has — `File`s carrying their `webkitRelativePath` — and everything
 * after that is the folder-upload path that exists: the plan dialog, the
 * folders created in one request, same-name files offered as new versions,
 * unchanged ones left alone. Nothing about a ZIP reaches the server, which is
 * why neither shelf's upload route, allow-list or quota check had to learn about
 * archives: they only ever see ordinary files.
 *
 * ## What is refused rather than half-taken
 *
 * A zip is whatever somebody had on their desktop, and it can claim to inflate
 * to anything. Two ceilings, checked from the central directory BEFORE a byte is
 * inflated: how many files, and how many bytes they add up to. Past either, the
 * whole archive is refused and says so. Taking "the first 500" would leave the
 * missing 400 indistinguishable from files nobody uploaded — the argument
 * `dropped-entries.ts` makes for its own bounds.
 *
 * What a person would not call a document is dropped quietly: the resource
 * forks and lock files that macOS and Office put inside archives. They are
 * never what anyone meant to upload, and listing them as "skipped" would only
 * teach people to read past the real notices.
 *
 * Everything else — including a type the shelf does not accept, and a ZIP
 * inside the ZIP — goes through as a file, so the one validator that already
 * reports "not supported" by name does so here too.
 */

import { unzipSync, type UnzipFileInfo } from 'fflate'
import { formatBytes } from '@/lib/format'
import { mimeTypeForFileName } from '@/shared/config/file-upload'
import { stampRelativePath } from './dropped-entries'
import { isZipArchive } from './zip-types'

/** The same file ceiling a dropped folder has, for the same reason. */
export const MAX_ZIP_ENTRIES = 2000

/**
 * What an archive may inflate to, in total. Held in memory twice over while the
 * `File`s are made, so this is a browser's headroom and not a policy: the
 * per-file limit and the organisation's storage quota are what govern the rest.
 */
export const MAX_ZIP_UNPACKED_BYTES = 1024 * 1024 * 1024

/** Why an archive gave nothing. Each is a sentence the reader is shown. */
export type ZipRefusal = 'unreadable' | 'empty' | 'tooManyFiles' | 'tooLarge'

export interface ZipNote {
  /** The archive's file name, for the sentence. */
  zip: string
  reason: ZipRefusal
  /** The ceiling that was passed, as the reader should see it. Empty when none was. */
  limit: string
}

export interface ZipExpansion {
  /** The files to upload: every loose file as given, every archive as its members. */
  files: File[]
  /** One per archive that gave nothing. Never about an individual member. */
  notes: ZipNote[]
}

/** Path segments that are never documents: macOS forks, Office locks, Windows thumbnails. */
const JUNK_SEGMENT = /^(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|~\$.*)$/i

/** `Plaene/EG/grundriss.pdf` as segments, or `null` for a name that climbs out of its folder. */
function safeSegments(entryName: string): string[] | null {
  const segments = entryName.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((segment) => segment === '..')) return null
  return segments
}

const isJunk = (segments: readonly string[]): boolean =>
  segments.some((segment) => JUNK_SEGMENT.test(segment))

/**
 * Where the members go: under their own top-level folder when the archive has
 * one (what "Compress folder" makes), else under a folder named after the
 * archive (what "Extract to folder" makes). Otherwise a zip of loose files would
 * spill them into whichever level the reader happens to be standing in.
 */
function rootFor(zipName: string, members: readonly string[][]): string | null {
  const first = members[0]?.[0]
  const sharesOneRoot = members.every((segments) => segments.length > 1 && segments[0] === first)
  return sharesOneRoot ? null : zipName.replace(/\.zip$/i, '')
}

interface Admission {
  admit: (info: UnzipFileInfo) => boolean
  entries: () => number
  unpackedBytes: () => number
}

/** The central-directory pass: decide per entry, from its header, whether to inflate it. */
function admission(): Admission {
  let entries = 0
  let unpackedBytes = 0
  const admit = (info: UnzipFileInfo): boolean => {
    if (info.name.endsWith('/')) return false
    const segments = safeSegments(info.name)
    if (!segments || segments.length === 0 || isJunk(segments)) return false
    entries += 1
    unpackedBytes += info.originalSize
    // Counted past the ceiling so the caller can refuse; never inflated past it.
    return entries <= MAX_ZIP_ENTRIES && unpackedBytes <= MAX_ZIP_UNPACKED_BYTES
  }
  return { admit, entries: () => entries, unpackedBytes: () => unpackedBytes }
}

const LIMIT_TEXT: Record<ZipRefusal, string> = {
  unreadable: '',
  empty: '',
  tooManyFiles: String(MAX_ZIP_ENTRIES),
  tooLarge: formatBytes(MAX_ZIP_UNPACKED_BYTES),
}

const refusal = (zip: File, reason: ZipRefusal): ZipExpansion => ({
  files: [],
  notes: [{ zip: zip.name, reason, limit: LIMIT_TEXT[reason] }],
})

async function expandZip(zip: File): Promise<ZipExpansion> {
  const gate = admission()
  let archive: Record<string, Uint8Array>
  try {
    archive = unzipSync(new Uint8Array(await zip.arrayBuffer()), { filter: gate.admit })
  } catch {
    // Not a zip, truncated, or encrypted: the library cannot tell these apart
    // and neither can the reader do anything different about them.
    return refusal(zip, 'unreadable')
  }
  if (gate.entries() > MAX_ZIP_ENTRIES) return refusal(zip, 'tooManyFiles')
  if (gate.unpackedBytes() > MAX_ZIP_UNPACKED_BYTES) return refusal(zip, 'tooLarge')

  const members = Object.entries(archive)
    .map(([name, bytes]) => ({ segments: safeSegments(name) ?? [], bytes }))
    .sort((a, b) => a.segments.join('/').localeCompare(b.segments.join('/')))
  if (members.length === 0) return refusal(zip, 'empty')

  const root = rootFor(zip.name, members.map((member) => member.segments))
  const files = members.map(({ segments, bytes }) => {
    const name = segments[segments.length - 1]
    const file = new File([bytes as BlobPart], name, { type: mimeTypeForFileName(name) })
    return stampRelativePath(file, (root ? [root, ...segments] : segments).join('/'))
  })
  return { files, notes: [] }
}

/**
 * The files to upload for what was dropped or picked: loose files unchanged,
 * every `.zip` replaced by its members. Order is kept, so a drop of `a.pdf` and
 * `b.zip` still reads a-then-b's-contents.
 */
export async function expandZips(files: readonly File[]): Promise<ZipExpansion> {
  const out: File[] = []
  const notes: ZipNote[] = []
  for (const file of files) {
    if (!isZipArchive(file)) {
      out.push(file)
      continue
    }
    const expanded = await expandZip(file)
    out.push(...expanded.files)
    notes.push(...expanded.notes)
  }
  return { files: out, notes }
}
