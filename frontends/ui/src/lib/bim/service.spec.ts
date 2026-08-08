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

vi.mock('server-only', () => ({}))

interface StoredObject {
  key: string
  body: string
  contentType: string | undefined
}

const stored: StoredObject[] = []
const deleted: string[] = []
let sourceBytes = ''

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
            transformToByteArray: async () => new TextEncoder().encode(sourceBytes),
          },
        }
      }
      if (name === 'PutObjectCommand') {
        stored.push({
          key: String(input.Key),
          body: String(input.Body),
          contentType: input.ContentType as string | undefined,
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
})

describe('buildBimDerivedKeys', () => {
  it('keeps the original filename as the digest object’s last path segment', () => {
    // Load-bearing: the backend records the URL basename as `file_name`, and
    // citations and chunk deletion both match documents on that exact string.
    expect(buildBimDerivedKeys(STORAGE_KEY)).toEqual({
      prefix: 'org/org_1/project/p1/doc/d1/_bim/',
      digestKey: 'org/org_1/project/p1/doc/d1/_bim/haus-a.ifc',
      indexKey: 'org/org_1/project/p1/doc/d1/_bim/index.json',
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
    expect(stored).toHaveLength(2)

    await deleteBimDerivedObjects(STORAGE_KEY, null)

    // Nested under `doc/<id>/`, so the document delete path's exact-key removals
    // never reach them — this is the only thing that does.
    expect(deleted.sort()).toEqual([
      'org/org_1/project/p1/doc/d1/_bim/haus-a.ifc',
      'org/org_1/project/p1/doc/d1/_bim/index.json',
    ])
  })

  it('does nothing for a key with no directory', async () => {
    await deleteBimDerivedObjects('haus-a.ifc', null)
    expect(deleted).toEqual([])
  })
})
