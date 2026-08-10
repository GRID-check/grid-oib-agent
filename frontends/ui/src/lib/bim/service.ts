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
export const BIM_ELEMENT_LIMIT = Number(process.env.BIM_ELEMENT_LIMIT ?? 200_000)

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
} | null {
  const index = storageKey.lastIndexOf('/')
  if (index <= 0 || index === storageKey.length - 1) return null
  const directory = storageKey.slice(0, index)
  const filename = storageKey.slice(index + 1)
  const prefix = `${directory}/${DERIVED_SEGMENT}/`
  return { prefix, digestKey: `${prefix}${filename}`, indexKey: `${prefix}index.json` }
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

    const index = await extractIfcModel(buffer, input.filename, { elementLimit: BIM_ELEMENT_LIMIT })
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
    const reason =
      error instanceof IfcExtractionError
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
  const listed = await s3Client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: keys.prefix, MaxKeys: 100 })
  )
  for (const object of listed.Contents ?? []) {
    if (!object.Key) continue
    await s3Client
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }))
      .catch(() => undefined)
  }
}
