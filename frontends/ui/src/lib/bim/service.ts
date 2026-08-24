/**
 * BIM service — turning an uploaded `.ifc` object into a queryable model.
 *
 * ## Why IFC does not go down the ordinary ingest path
 *
 * Every other upload is handed straight to the Python ingestor, which extracts
 * text and embeds it. An IFC file is a STEP physical file: tens of megabytes of
 * `#412=IFCCARTESIANPOINT((1.2,0.,3.));`. Embedding that produces chunks that
 * match nothing and bury everything — the same failure the backend already
 * guards against for raw PDF bytes.
 *
 * So the raw model is never ingested. It is parsed here (ifc-lite, in-process),
 * which yields two artefacts:
 *
 *   1. a **structured index** → `bim_models` + `bim_elements`, which the agent
 *      queries deterministically (`query.ts`);
 *   2. a **Markdown digest** → written back to object storage and ingested in
 *      the model's place, so the model participates in ordinary retrieval.
 *
 * The digest object is deliberately named with the ORIGINAL filename, because
 * the whole citation and deletion machinery keys on `file_name`: chunks written
 * as `haus-a.ifc` resolve to the `haus-a.ifc` document row, so a citation opens
 * the model and deleting the document removes its chunks. Only its
 * `Content-Type` differs (`text/markdown`), which is what tells the backend to
 * read it as text.
 */

import 'server-only'
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { s3Client } from '@/lib/s3'
import { resolveDocumentBucket } from '@/lib/storage/bucket'
import { completeBimModel, failBimModel, startBimModel } from './repository'
// Statically importable despite what it wraps: the module reads the zip
// directory with a DataView and nothing else, and reaches for the parser (and
// therefore jszip) behind a dynamic import inside the one function that needs
// it. So the cost of naming it here is the cost of the DataView reader.
import { IfcArchiveError, unwrapIfcArchive } from './ifc-archive'
import { isIfcFilename, maxIfcBytesFrom } from './types'

/**
 * Largest IFC accepted for extraction, independent of the upload size limit.
 *
 * Parsing happens in the BFF's Node process. A 600 MB federated model would
 * hold a worker for minutes and allocate several times its own size in
 * columnar arrays, so it is refused with a specific, readable reason rather
 * than taking the process down. Raise it only alongside moving extraction out
 * of the request process.
 */
export const MAX_IFC_BYTES = maxIfcBytesFrom(process.env)

/** Cap on `bim_elements` rows per model; see `extract.ts`. */
/**
 * Rows stored per model, and the guard that makes it a number.
 *
 * `Number(process.env.X ?? 200_000)` reads `""` as `0` and anything
 * non-numeric as `NaN`, and both failure modes are silent: `0` clamps to a
 * ONE-element cap (with `truncatedAt: 1`, so every surface blames the model),
 * and `NaN` makes `elements.length >= limit` permanently false, which removes
 * the OOM guard the cap exists to be. One mis-set variable, no error either
 * way.
 */
const CONFIGURED_ELEMENT_LIMIT = Number(process.env.BIM_ELEMENT_LIMIT)
export const BIM_ELEMENT_LIMIT =
  Number.isFinite(CONFIGURED_ELEMENT_LIMIT) && CONFIGURED_ELEMENT_LIMIT > 0
    ? Math.trunc(CONFIGURED_ELEMENT_LIMIT)
    : 200_000

/** Directory holding everything derived from a model, beside the source object. */
const DERIVED_SEGMENT = '_bim'

export { isIfcFilename }

/**
 * Keys for the artefacts derived from a model, as siblings of its own object.
 *
 * `<dir>/_bim/<original filename>` for the digest — the last path segment is
 * what the backend records as `file_name`, and it must equal the document's
 * filename for citations and chunk deletion to resolve.
 */
export function buildBimDerivedKeys(storageKey: string): {
  prefix: string
  digestKey: string
  indexKey: string
  sourceKey: string
} | null {
  const index = storageKey.lastIndexOf('/')
  if (index <= 0 || index === storageKey.length - 1) return null
  const directory = storageKey.slice(0, index)
  const filename = storageKey.slice(index + 1)
  const prefix = `${directory}/${DERIVED_SEGMENT}/`
  return {
    prefix,
    digestKey: `${prefix}${filename}`,
    indexKey: `${prefix}index.json`,
    // The viewer's copy of the source: same bytes, gzipped. See
    // `writeCompressedSource` for why it is worth an extra object.
    sourceKey: `${prefix}source.ifc.gz`,
  }
}

/**
 * Store a gzipped copy of the source for the VIEWER to download.
 *
 * An IFC is STEP — plain ASCII text, hugely repetitive — and compresses by
 * roughly 5–10×. The viewer's slowest phase by a wide margin is pulling the
 * raw file into the browser to triangulate it: a 149 MB model is 149 MB on the
 * wire every time anyone opens the page, because a presigned URL is unique per
 * request and therefore never cached. Serving ~20 MB instead is the single
 * biggest improvement available to that page, and it costs one object.
 *
 * `ContentEncoding: gzip` is what makes it transparent: the browser inflates
 * the body itself, so the geometry kernel still receives the exact bytes the
 * architect uploaded and nothing downstream knows the difference.
 *
 * The uncompressed length travels as user metadata because `Content-Length` on
 * a gzipped response describes the COMPRESSED body while a streaming reader
 * counts DECODED bytes — without it a progress bar reaches 100% at a seventh of
 * the file and stops meaning anything.
 *
 * Best-effort on purpose. This is an optimisation, and a model whose gzip write
 * fails must still be viewable from the original object.
 */
async function writeCompressedSource(
  bucket: string,
  key: string,
  buffer: Uint8Array
): Promise<void> {
  try {
    const { gzip } = await import('node:zlib')
    const { promisify } = await import('node:util')
    // Async rather than `gzipSync`: this runs inside the upload request, and
    // compressing a hundred megabytes on the event loop would stall every
    // other request in the process for the duration.
    const compressed = await promisify(gzip)(buffer)
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: compressed,
        ContentType: 'application/octet-stream',
        ContentEncoding: 'gzip',
        Metadata: { 'uncompressed-length': String(buffer.byteLength) },
      })
    )
  } catch {
    // No rethrow: the viewer falls back to the original object, which is
    // slower and completely correct.
  }
}

export interface BimExtractionInput {
  organizationId: string
  projectId: string | null
  documentId: string
  filename: string
  storageKey: string
  storageBucket: string | null
  /**
   * Hands the digest object to the ordinary ingest dispatcher. Injected rather
   * than imported so this module does not depend on the documents service that
   * calls it — the dependency runs one way, and the dispatch is stubbable in a
   * test without mocking the backend.
   */
  dispatchDigest: (digestStorageKey: string) => Promise<unknown>
}

export interface BimExtractionOutcome {
  modelId: string
  status: 'ready' | 'failed'
  elementCount: number
  error?: string
}

/**
 * Read an object into memory, refusing one that is too big BEFORE reading it.
 *
 * The check used to be on `buffer.byteLength` at the caller, which is a
 * rhetorical cap: by the time it can be evaluated the whole object is already
 * resident. On a 1 GiB pod, with an upload limit that is a separate,
 * independently configurable number, a file above the extraction limit was
 * `transformToByteArray`-ed in full and only then declined — an OOM kill on
 * the way to reporting a polite error.
 *
 * `ContentLength` comes back in the same `GetObject` response, ahead of the
 * body, so the size is knowable before the read. An object that does not
 * report one is read and checked afterwards, as before: a missing header is
 * not a licence to skip the limit.
 */
async function fetchObject(bucket: string, key: string): Promise<ArrayBuffer> {
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const declared = response.ContentLength
  if (typeof declared === 'number' && declared > MAX_IFC_BYTES) {
    throw new IfcTooLargeError(declared)
  }
  const bytes = await response.Body?.transformToByteArray()
  if (!bytes) throw new Error('object body was empty')
  if (bytes.byteLength > MAX_IFC_BYTES) throw new IfcTooLargeError(bytes.byteLength)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** A model above {@link MAX_IFC_BYTES}, raised from wherever the size is learnt. */
class IfcTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(
      `Model is ${Math.round(bytes / 1024 / 1024)} MB, above the ` +
        `${Math.round(MAX_IFC_BYTES / 1024 / 1024)} MB extraction limit`
    )
    this.name = 'IfcTooLargeError'
  }
}

/**
 * Parse an uploaded IFC, persist the index, and hand the digest to ingestion.
 *
 * Never throws: a model that fails to parse is a documented state
 * (`bim_models.status = 'failed'` with the reason), not an exception for a
 * caller that has already responded to the user. The document row itself stays
 * untouched — the bytes are stored and downloadable regardless of whether we
 * could read them.
 */
export async function runBimExtraction(input: BimExtractionInput): Promise<BimExtractionOutcome> {
  const bucket = resolveDocumentBucket(input.storageBucket)
  const modelId = await startBimModel({
    organizationId: input.organizationId,
    projectId: input.projectId,
    documentId: input.documentId,
  })

  // Loaded here, not at module scope: `./extract` pulls in `@ifc-lite/parser`
  // and its bundled IFC2X3/4/4X3 schema tables — several megabytes that every
  // document upload, download and delete would otherwise carry for a feature
  // most of them never touch.
  const { extractIfcModel, IfcExtractionError } = await import('./extract')
  const { buildModelDigest } = await import('./digest')

  try {
    // The size limit is enforced inside `fetchObject`, before the object is
    // resident — see the note there.
    let buffer: ArrayBuffer
    try {
      buffer = await fetchObject(bucket, input.storageKey)
    } catch (error) {
      if (error instanceof IfcTooLargeError) {
        throw new IfcExtractionError('parse-failed', error.message)
      }
      throw error
    }

    /*
      Open the container HERE, once, and let everything downstream see STEP.

      `extractIfcModel` unwraps for itself, so the parse was already correct —
      but it unwraps privately, and the two things that happen with these bytes
      besides parsing were both wrong for a `.ifczip`:

        - the ceiling was applied to the COMPRESSED object, so a 40 MB archive
          holding a 300 MB model passed a limit that exists to keep this
          process alive (`unwrapIfcArchive` reads the declared size out of the
          zip directory, before anything is inflated);
        - the viewer's source object was written from the archive, and the
          browser's geometry kernel does not unwrap zip — every zipped model
          therefore opened as an empty viewport.

      Non-archive input comes back unchanged and costs a four-byte magic check,
      so nothing about the ordinary `.ifc` path changes.
    */
    const { bytes: source } = await unwrapIfcArchive(buffer, MAX_IFC_BYTES)

    const index = await extractIfcModel(source, input.filename, { elementLimit: BIM_ELEMENT_LIMIT })
    const { elements, ...summary } = index
    const keys = buildBimDerivedKeys(input.storageKey)

    let indexKey: string | null = null
    let digestKey: string | null = null
    if (keys) {
      const digest = buildModelDigest(summary, elements, { filename: input.filename })
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keys.indexKey,
          Body: Buffer.from(JSON.stringify(index)),
          ContentType: 'application/json',
        })
      )
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keys.digestKey,
          Body: Buffer.from(digest, 'utf8'),
          // Drives `_infer_suffix` on the backend: the temp file gets `.md` and
          // is read as text, rather than `.ifc` and read as unknown binary.
          ContentType: 'text/markdown; charset=utf-8',
        })
      )
      // `source`, never `buffer`: the viewer's copy has to be the MODEL. For a
      // `.ifczip` those differ, and handing the browser the container is the
      // difference between a building and an empty scene.
      await writeCompressedSource(bucket, keys.sourceKey, new Uint8Array(source))
      indexKey = keys.indexKey
      digestKey = keys.digestKey
    }

    await completeBimModel({
      modelId,
      organizationId: input.organizationId,
      summary,
      elements,
      indexStorageKey: indexKey,
      indexStorageBucket: input.storageBucket,
    })

    if (digestKey) {
      // Ingestion is best-effort and deliberately last: the model is already
      // queryable without it, and a backend that is down must not cost us the
      // extraction we just paid for.
      await input.dispatchDigest(digestKey).catch(() => undefined)
    }

    return { modelId, status: 'ready', elementCount: elements.length }
  } catch (error) {
    // `instanceof` against the dynamically-imported class is still sound: the
    // module registry caches it, so the constructor the throw site used is the
    // one bound above.
    //
    // An archive refusal keeps its own sentence rather than collapsing into
    // "not a valid IFC file": "the archive holds two models" and "the unpacked
    // model is 900 MB" are both things the person who uploaded it can act on,
    // and neither is true of the file they see in the list.
    const reason =
      error instanceof IfcArchiveError
        ? `Das IFC-Archiv konnte nicht verarbeitet werden: ${error.message}`
        : error instanceof IfcExtractionError
          ? error.code === 'not-ifc'
            ? 'Die Datei ist keine gültige IFC-Datei (STEP/ISO-10303-21).'
            : `Das IFC-Modell konnte nicht gelesen werden: ${error.message}`
          : 'Das IFC-Modell konnte nicht verarbeitet werden.'
    await failBimModel(modelId, input.organizationId, reason).catch(() => undefined)
    return { modelId, status: 'failed', elementCount: 0, error: reason }
  }
}

/**
 * Remove the derived `_bim/` objects when a document is deleted.
 *
 * The single-document delete path removes the object and its `_thumb.jpg`
 * sibling by exact key; anything nested below `doc/<id>/` would survive until a
 * project-wide purge. Listing the prefix is one round trip and covers whatever
 * the extractor wrote, including artefacts a future version adds.
 */
export async function deleteBimDerivedObjects(
  storageKey: string,
  storageBucket: string | null
): Promise<void> {
  const keys = buildBimDerivedKeys(storageKey)
  if (!keys) return
  const bucket = resolveDocumentBucket(storageBucket)

  // Paged to exhaustion. One `MaxKeys: 100` call silently stopped at the
  // hundredth object, so anything past it — including the source gzip, which
  // is the largest thing here and the one that carries the building — stayed
  // in the bucket after the tenant had been told the document was deleted.
  // A prefix holds a handful of objects today; "today" is not a retention
  // guarantee.
  let continuationToken: string | undefined
  do {
    const listed = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: keys.prefix,
        ContinuationToken: continuationToken,
      })
    )
    for (const object of listed.Contents ?? []) {
      if (!object.Key) continue
      await s3Client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }))
        .catch(() => undefined)
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
  } while (continuationToken)
}
