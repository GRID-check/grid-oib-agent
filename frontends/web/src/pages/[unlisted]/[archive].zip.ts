/**
 * The unlisted image page's ZIPs: `/<DOWNLOADS_SLUG>/<work>.zip` for one work,
 * `/<DOWNLOADS_SLUG>/alle.zip` for every riso file.
 *
 * Streamed per request by archiver rather than built into the image: the
 * files already lie in dist/client, so a build-time ZIP would ship every byte
 * twice (about 30 MB more per image) for a page few people open. archiver
 * because it streams from the files with backpressure (JSZip assembles the
 * archive in memory first). `store: true`: WebP, PNG and JPEG are compressed
 * already, and deflating them again costs CPU for a percent or two.
 *
 * The contents change only with a deploy, so the ETag is a hash of the file
 * list with each file's `?v=` content hash: a browser revalidates and gets a
 * 304 until the art changes.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { APIRoute } from 'astro'
import { ZipArchive, type ArchiverError } from 'archiver'
import { archiveEntries, archiveName, publicRoot } from '../../lib/downloads'
import { DOWNLOADS_SLUG } from '../../lib/unlisted'

export const prerender = false

/** Names and content hashes of the files: it changes exactly when the archive would. */
const etagOf = (entries: { href: string; name: string }[]) =>
  `"${crypto.createHash('sha256').update(entries.map((e) => `${e.name} ${e.href}`).join('\n')).digest('hex').slice(0, 16)}"`

export const GET: APIRoute = ({ params, request }) => {
  const archive = params.archive ?? ''
  const entries = params.unlisted === DOWNLOADS_SLUG ? archiveEntries(archive) : null
  if (!entries) return new Response(null, { status: 404 })

  const etag = etagOf(entries)
  const headers = {
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    ETag: etag,
    'X-Robots-Tag': 'noindex, nofollow',
  }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })

  const zip = new ZipArchive({ store: true })
  const root = publicRoot()
  for (const e of entries) zip.file(path.join(root, e.path), { name: e.name })
  // a missing file is only a warning to archiver; here it is a broken archive
  zip.on('warning', (err: ArchiverError) => zip.destroy(err))
  zip.finalize().catch((err: Error) => zip.destroy(err))
  return new Response(Readable.toWeb(zip) as ReadableStream<Uint8Array>, {
    headers: {
      ...headers,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${archiveName(archive)}"`,
    },
  })
}
