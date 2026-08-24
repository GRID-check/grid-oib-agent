/**
 * @vitest-environment node
 */

/**
 * The extraction orchestration, with object storage and the repository stubbed.
 *
 * What matters here is not that ifc-lite can parse (that is `extract.spec.ts`,
 * against a real file) but the CONTRACT around it: the derived objects land
 * where the rest of the system looks for them, the digest is named so citations
 * resolve, a broken model becomes a recorded failure rather than a thrown
 * exception into a request that has already responded, and a backend that
 * refuses the digest does not cost us the extraction.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createZip } from './zip'

vi.mock('server-only', () => ({}))

interface StoredObject {
  key: string
  body: string
  contentType: string | undefined
  /** Set only on the viewer's gzipped source; the mechanism, not decoration. */
  contentEncoding: string | undefined
  metadata: Record<string, string> | undefined
  /** Bytes actually written, so a "compressed" object can be shown to be smaller. */
  byteLength: number | undefined
  /** The body as written, when it is binary — `String(body)` loses gzip. */
  raw: Uint8Array | undefined
}

const stored: StoredObject[] = []
const deleted: string[] = []
let sourceBytes = ''
/** Set when the stored object is not text — a `.ifczip` upload. */
let sourceBinary: Uint8Array | null = null
/** Key suffix whose next PUT should fail, for the best-effort write paths. */
let putFailureSuffix: string | null = null
function failNextPutFor(suffix: string): void {
  putFailureSuffix = suffix
}

/**
 * A minimal S3 stand-in that records what was written. The command objects the
 * service builds are real, so their shape is checked by the SDK's own types;
 * this only has to route them by constructor name and remember the effect.
 */
vi.mock('@/lib/s3', () => ({
  s3Client: {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name
      const input = command.input
      if (name === 'GetObjectCommand') {
        return {
          Body: {
            transformToByteArray: async () =>
              sourceBinary ?? new TextEncoder().encode(sourceBytes),
          },
        }
      }
      if (name === 'PutObjectCommand') {
        if (putFailureSuffix && String(input.Key).endsWith(putFailureSuffix)) {
          putFailureSuffix = null
          throw new Error('store unavailable')
        }
        stored.push({
          key: String(input.Key),
          body: String(input.Body),
          contentType: input.ContentType as string | undefined,
          contentEncoding: input.ContentEncoding as string | undefined,
          metadata: input.Metadata as Record<string, string> | undefined,
          byteLength: (input.Body as Uint8Array | undefined)?.byteLength,
          raw: input.Body instanceof Uint8Array ? input.Body : undefined,
        })
        return {}
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = String(input.Prefix)
        return { Contents: stored.filter((o) => o.key.startsWith(prefix)).map((o) => ({ Key: o.key })) }
      }
      if (name === 'DeleteObjectCommand') {
        deleted.push(String(input.Key))
        return {}
      }
      throw new Error(`unexpected command ${name}`)
    },
  },
}))

vi.mock('@/lib/storage/bucket', () => ({
  resolveDocumentBucket: (bucket: string | null) => bucket ?? 'grid-documents',
}))

const started: unknown[] = []
const completed: Array<{ elements: unknown[]; indexStorageKey: string | null }> = []
const failed: Array<{ modelId: string; reason: string }> = []

vi.mock('./repository', () => ({
  startBimModel: async (input: unknown) => {
    started.push(input)
    return 'model-1'
  },
  completeBimModel: async (input: { elements: unknown[]; indexStorageKey: string | null }) => {
    completed.push(input)
  },
  failBimModel: async (modelId: string, _org: string, reason: string) => {
    failed.push({ modelId, reason })
  },
}))

const { buildBimDerivedKeys, deleteBimDerivedObjects, runBimExtraction } = await import('./service')

const VALID_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('haus-a.ifc','2026-01-01T00:00:00',(''),(''),'t','t','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0GridServiceProject01',$,'Haus A',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('0GridServiceStorey01',$,'Erdgeschoss',$,$,$,$,$,.ELEMENT.,0.);
#3=IFCWALL('0GridServiceWall00001',$,'Aussenwand',$,$,$,$,'W-1',.SOLIDWALL.);
#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('0GridServiceCont0001',$,$,$,(#3),#2);
ENDSEC;
END-ISO-10303-21;
`

const STORAGE_KEY = 'org/org_1/project/p1/doc/d1/haus-a.ifc'

function baseInput(dispatchDigest = vi.fn(async () => undefined)) {
  return {
    organizationId: 'org_1',
    projectId: 'p1',
    documentId: 'd1',
    filename: 'haus-a.ifc',
    storageKey: STORAGE_KEY,
    storageBucket: null,
    dispatchDigest,
  }
}

beforeEach(() => {
  stored.length = 0
  deleted.length = 0
  started.length = 0
  completed.length = 0
  failed.length = 0
  sourceBytes = VALID_IFC
  sourceBinary = null
  putFailureSuffix = null
})

describe('buildBimDerivedKeys', () => {
  it('keeps the original filename as the digest object’s last path segment', () => {
    // Load-bearing: the backend records the URL basename as `file_name`, and
    // citations and chunk deletion both match documents on that exact string.
    expect(buildBimDerivedKeys(STORAGE_KEY)).toEqual({
      prefix: 'org/org_1/project/p1/doc/d1/_bim/',
      digestKey: 'org/org_1/project/p1/doc/d1/_bim/haus-a.ifc',
      indexKey: 'org/org_1/project/p1/doc/d1/_bim/index.json',
      sourceKey: 'org/org_1/project/p1/doc/d1/_bim/source.ifc.gz',
    })
  })

  it('refuses a key with no directory rather than writing to the bucket root', () => {
    expect(buildBimDerivedKeys('haus-a.ifc')).toBeNull()
    expect(buildBimDerivedKeys('some/dir/')).toBeNull()
  })
})

describe('runBimExtraction', () => {
  it('parses, persists and hands the digest to ingestion', async () => {
    const dispatchDigest = vi.fn(async () => undefined)
    const outcome = await runBimExtraction(baseInput(dispatchDigest))

    expect(outcome).toMatchObject({ modelId: 'model-1', status: 'ready', elementCount: 1 })
    expect(started[0]).toMatchObject({ organizationId: 'org_1', projectId: 'p1', documentId: 'd1' })
    expect(completed[0].elements).toHaveLength(1)
    expect(dispatchDigest).toHaveBeenCalledWith('org/org_1/project/p1/doc/d1/_bim/haus-a.ifc')
  })

  it('writes the digest as markdown so the backend reads it as text', async () => {
    await runBimExtraction(baseInput())

    const digest = stored.find((object) => object.key.endsWith('/_bim/haus-a.ifc'))
    // A `.ifc` content type would make the backend infer a `.ifc` suffix and
    // hand the file to a reader that garbles it — the whole point of the digest.
    expect(digest?.contentType).toBe('text/markdown; charset=utf-8')
    expect(digest?.body).toContain('# BIM-Modell: Haus A')

    const index = stored.find((object) => object.key.endsWith('/_bim/index.json'))
    expect(index?.contentType).toBe('application/json')
    expect(JSON.parse(index?.body ?? '{}')).toMatchObject({ schema: 'IFC4' })
  })

  it('records a failure instead of throwing when the bytes are not IFC', async () => {
    sourceBytes = 'this is not an IFC file'
    const dispatchDigest = vi.fn(async () => undefined)

    const outcome = await runBimExtraction(baseInput(dispatchDigest))

    expect(outcome.status).toBe('failed')
    expect(failed[0]).toMatchObject({ modelId: 'model-1' })
    expect(failed[0].reason).toContain('keine gültige IFC-Datei')
    expect(completed).toHaveLength(0)
    expect(dispatchDigest).not.toHaveBeenCalled()
  })

  it('keeps the extraction when the ingest dispatch fails', async () => {
    const dispatchDigest = vi.fn(async () => {
      throw new Error('backend down')
    })

    const outcome = await runBimExtraction(baseInput(dispatchDigest))

    // The model is queryable without the digest; losing the parse because the
    // ingestor was restarting would be the expensive half of the work thrown
    // away for the cheap half.
    expect(outcome.status).toBe('ready')
    expect(completed).toHaveLength(1)
    expect(failed).toHaveLength(0)
  })
})

describe('deleteBimDerivedObjects', () => {
  it('removes everything under the model’s derived prefix', async () => {
    await runBimExtraction(baseInput())
    expect(stored).toHaveLength(3)

    await deleteBimDerivedObjects(STORAGE_KEY, null)

    // Nested under `doc/<id>/`, so the document delete path's exact-key removals
    // never reach them — this is the only thing that does.
    // The gzip is swept with everything else: it lives under the same prefix,
    // so deleting a model cannot leave a compressed copy of it behind.
    expect(deleted.sort()).toEqual([
      'org/org_1/project/p1/doc/d1/_bim/haus-a.ifc',
      'org/org_1/project/p1/doc/d1/_bim/index.json',
      'org/org_1/project/p1/doc/d1/_bim/source.ifc.gz',
    ])
  })

  it('does nothing for a key with no directory', async () => {
    await deleteBimDerivedObjects('haus-a.ifc', null)
    expect(deleted).toEqual([])
  })
})

describe('the viewer’s compressed source', () => {
  it('is stored gzipped, smaller than the original, and says how big the original was', async () => {
    await runBimExtraction(baseInput())

    const gzip = stored.find((object) => object.key.endsWith('/source.ifc.gz'))
    expect(gzip).toBeDefined()
    // `Content-Encoding` is the whole mechanism: it is what makes the browser
    // inflate the body itself, so the geometry kernel still receives the exact
    // bytes the architect uploaded.
    expect(gzip?.contentEncoding).toBe('gzip')
    // Without this the viewer's progress bar divides decoded bytes by the
    // compressed length and pins itself at 100%.
    expect(Number(gzip?.metadata?.['uncompressed-length'])).toBeGreaterThan(0)
  })

  it('actually compresses — STEP is text, and this is the point of the object', async () => {
    await runBimExtraction(baseInput())

    const gzip = stored.find((object) => object.key.endsWith('/source.ifc.gz'))
    const original = Number(gzip?.metadata?.['uncompressed-length'])
    expect(gzip?.byteLength).toBeLessThan(original)
  })

  it('does not fail the extraction when the compressed write fails', async () => {
    // An optimisation must never cost a model. The gzip is best-effort and the
    // viewer falls back to the original object.
    failNextPutFor('/source.ifc.gz')

    const outcome = await runBimExtraction(baseInput())

    expect(outcome.status).toBe('ready')
  })

  it('holds the MODEL for a `.ifczip`, not the container', async () => {
    /*
      The viewer parses in the browser and `@ifc-lite/geometry` does not unwrap
      zip — it finds no entities and reports no error, so a zipped upload
      rendered as an empty viewport under a model the server had already read.
      The source object is what the browser is handed, so it has to be STEP for
      every model, whatever the upload was wrapped in.
    */
    const archive = createZip([{ path: 'haus-a.ifc', content: VALID_IFC }])
    sourceBinary = archive

    const outcome = await runBimExtraction({ ...baseInput(), filename: 'haus-a.ifczip' })
    expect(outcome.status).toBe('ready')

    const gzip = stored.find((object) => object.key.endsWith('/source.ifc.gz'))
    const { gunzipSync } = await import('node:zlib')
    expect(gzip?.raw).toBeDefined()
    const written = gunzipSync(gzip?.raw as Uint8Array)
    expect(new TextDecoder().decode(written)).toBe(VALID_IFC)
    // And it is the model's size the progress bar divides by, not the zip's.
    expect(Number(gzip?.metadata?.['uncompressed-length'])).toBe(
      new TextEncoder().encode(VALID_IFC).byteLength
    )
  })

  it('reports an archive refusal in its own words, not as "not a valid IFC file"', async () => {
    // "The archive holds two models" is something the uploader can act on, and
    // it is not true of the file they see in the list. The ceiling refusal —
    // read from the zip directory before anything is inflated — takes the same
    // branch; `ifc-archive.spec.ts` covers the sizes themselves.
    sourceBinary = createZip([
      { path: 'haus-a.ifc', content: VALID_IFC },
      { path: 'haus-b.ifc', content: VALID_IFC },
    ])

    const outcome = await runBimExtraction({ ...baseInput(), filename: 'beide.ifczip' })

    expect(outcome.status).toBe('failed')
    expect(failed[0].reason).toContain('IFC-Archiv')
    expect(failed[0].reason).toContain('exactly one')
    expect(completed).toHaveLength(0)
  })
})
