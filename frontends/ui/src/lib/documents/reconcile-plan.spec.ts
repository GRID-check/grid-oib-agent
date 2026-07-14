import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECONCILE_CONFIG,
  isIgnoredName,
  reconcilePlan,
  summarizePlan,
  type DocumentRow,
  type ObjectListing,
  type ReconcileConfig,
} from './reconcile-plan'

// A fixed clock so every case is deterministic.
const NOW = 1_700_000_000_000
const cfg: ReconcileConfig = DEFAULT_RECONCILE_CONFIG
const SETTLED = NOW - cfg.settleWindowMs - 1 // older than the settle window
const FRESH = NOW - 1_000 // within the settle window
const OLD_ROW = NOW - cfg.deletionGraceMs - 1 // older than the deletion grace
const YOUNG_ROW = NOW - 1_000 // within the deletion grace

const KEY = 'org/org_acme/project/proj_atlas/doc/d1/plan.pdf'

function obj(over: Partial<ObjectListing> = {}): ObjectListing {
  return { key: KEY, etag: 'etag-v1', lastModifiedMs: SETTLED, size: 100, ...over }
}
function row(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    documentId: 'd1',
    objectKey: KEY,
    recordedEtag: 'etag-v1',
    status: 'completed',
    createdAtMs: OLD_ROW,
    attempts: 0,
    ...over,
  }
}

describe('isIgnoredName (guard 1: name filter)', () => {
  it.each([
    ['dir/~$plan.docx', true], // Office owner/lock
    ['dir/.~lock.plan.odt#', true], // LibreOffice
    ['dir/._plan.pdf', true], // macOS AppleDouble
    ['dir/.DS_Store', true],
    ['Thumbs.db', true],
    ['desktop.ini', true],
    ['dir/drawing.ac$', true], // AutoCAD
    ['dir/drawing.sv$', true],
    ['dir/drawing.dwl', true],
    ['dir/drawing.dwl2', true],
    ['dir/save.tmp', true],
    ['dir/save.TMP', true], // case-insensitive suffix
    ['dir/file.partial', true], // rclone partial
    ['dir/file.crdownload', true],
    ['dir/file.bak', true],
    ['dir/.plan.swp', true],
    ['org/org_acme/project/proj_atlas/folder/', true], // folder placeholder
    ['', true], // empty
    ['dir/plan.pdf', false],
    ['dir/report.docx', false],
    ['dir/model.dwg', false], // the real CAD file, NOT .dwl
    ['dir/archive.zip', false],
  ])('isIgnoredName(%j) === %s', (key, expected) => {
    expect(isIgnoredName(key)).toBe(expected)
  })
})

describe('arrived: object present, no row', () => {
  it('settled new object → ingest-new', () => {
    const plan = reconcilePlan([obj()], [], NOW, cfg)
    expect(plan.actions).toEqual([{ type: 'ingest-new', objectKey: KEY, etag: 'etag-v1' }])
    expect(plan.skips).toEqual([])
  })

  it('guard 2: a still-settling new object is skipped, not ingested', () => {
    const plan = reconcilePlan([obj({ lastModifiedMs: FRESH })], [], NOW, cfg)
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'not-quiescent', objectKey: KEY }])
  })

  it('guard 2: a future LastModified (clock skew) is treated as not-quiescent', () => {
    const plan = reconcilePlan([obj({ lastModifiedMs: NOW + 60_000 })], [], NOW, cfg)
    expect(plan.actions).toEqual([])
    expect(plan.skips[0].reason).toBe('not-quiescent')
  })

  it('guard 1: an ignored temp object is never ingested', () => {
    const tmp = 'org/org_acme/project/proj_atlas/doc/d1/~$plan.pdf'
    const plan = reconcilePlan([obj({ key: tmp })], [], NOW, cfg)
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'ignored-name', objectKey: tmp }])
  })
})

describe('changed: object present, row present, etag differs (guard 3)', () => {
  it('settled change → reingest-changed (delete-then-reingest) with both etags', () => {
    const plan = reconcilePlan([obj({ etag: 'etag-v2' })], [row({ recordedEtag: 'etag-v1' })], NOW, cfg)
    expect(plan.actions).toEqual([
      { type: 'reingest-changed', documentId: 'd1', objectKey: KEY, oldEtag: 'etag-v1', newEtag: 'etag-v2' },
    ])
  })

  it('quoted vs unquoted etags are equal → no spurious reingest', () => {
    const plan = reconcilePlan([obj({ etag: '"etag-v1"' })], [row({ recordedEtag: 'etag-v1' })], NOW, cfg)
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'up-to-date', objectKey: KEY, documentId: 'd1' }])
  })

  it('guard 2 dominates guard 3: a changed-but-unsettled object waits (embeddings not replaced yet)', () => {
    const plan = reconcilePlan(
      [obj({ etag: 'etag-v2', lastModifiedMs: FRESH })],
      [row({ recordedEtag: 'etag-v1' })],
      NOW,
      cfg,
    )
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'not-quiescent', objectKey: KEY, documentId: 'd1' }])
  })

  it('a changed object re-ingests even when the row is completed', () => {
    const plan = reconcilePlan([obj({ etag: 'zzz' })], [row({ status: 'completed', recordedEtag: 'etag-v1' })], NOW, cfg)
    expect(plan.actions[0].type).toBe('reingest-changed')
  })
})

describe('completed + unchanged', () => {
  it('etag matches → up-to-date skip (no work)', () => {
    const plan = reconcilePlan([obj()], [row({ status: 'completed', recordedEtag: 'etag-v1' })], NOW, cfg)
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'up-to-date', objectKey: KEY, documentId: 'd1' }])
  })

  it('legacy completed row with no baseline etag → adopt-etag (baseline, no reingest)', () => {
    const plan = reconcilePlan([obj({ etag: 'etag-cur' })], [row({ status: 'completed', recordedEtag: null })], NOW, cfg)
    expect(plan.actions).toEqual([{ type: 'adopt-etag', documentId: 'd1', objectKey: KEY, etag: 'etag-cur' }])
  })
})

describe('not-yet-ingested: row present, unchanged, non-terminal status', () => {
  it.each(['uploaded', 'pending', 'processing', 'ingesting', 'failed'] as const)(
    'status %s + attempts remaining + settled → retry-ingest',
    (status) => {
      const plan = reconcilePlan([obj()], [row({ status, recordedEtag: 'etag-v1', attempts: 3 })], NOW, cfg)
      expect(plan.actions).toEqual([
        { type: 'retry-ingest', documentId: 'd1', objectKey: KEY, etag: 'etag-v1', attempts: 3 },
      ])
    },
  )

  it('recordedEtag null + non-terminal → retry (never ingested, nothing to adopt)', () => {
    const plan = reconcilePlan([obj()], [row({ status: 'uploaded', recordedEtag: null, attempts: 0 })], NOW, cfg)
    expect(plan.actions[0]).toMatchObject({ type: 'retry-ingest', documentId: 'd1' })
  })

  it('poison guard: attempts >= maxAttempts → attempts-exhausted skip, never retried', () => {
    const plan = reconcilePlan(
      [obj()],
      [row({ status: 'failed', recordedEtag: 'etag-v1', attempts: cfg.maxAttempts })],
      NOW,
      cfg,
    )
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'attempts-exhausted', objectKey: KEY, documentId: 'd1' }])
  })

  it('guard 2: a non-terminal row whose object is still settling waits', () => {
    const plan = reconcilePlan(
      [obj({ lastModifiedMs: FRESH })],
      [row({ status: 'pending', recordedEtag: 'etag-v1' })],
      NOW,
      cfg,
    )
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'not-quiescent', objectKey: KEY, documentId: 'd1' }])
  })
})

describe('disappeared: row present, object gone (guards 4 & 5)', () => {
  it('old row + object gone → enqueue-deletion (pipeline backstop, not a hard delete)', () => {
    const plan = reconcilePlan([], [row({ createdAtMs: OLD_ROW })], NOW, cfg)
    expect(plan.actions).toEqual([{ type: 'enqueue-deletion', documentId: 'd1', objectKey: KEY }])
  })

  it('guard 4: a young object-less row is an upload in flight, NOT a deletion', () => {
    const plan = reconcilePlan([], [row({ createdAtMs: YOUNG_ROW })], NOW, cfg)
    expect(plan.actions).toEqual([])
    expect(plan.skips).toEqual([{ type: 'skip', reason: 'deletion-grace', objectKey: KEY, documentId: 'd1' }])
  })

  it('a row whose object is present-but-ignored is NOT treated as a deletion', () => {
    // The object exists in S3 but its name is filtered; the row must not be
    // enqueued for deletion just because the object is absent from the diff set.
    const ignored = 'org/org_acme/project/proj_atlas/doc/d1/~$plan.pdf'
    const plan = reconcilePlan(
      [obj({ key: ignored })],
      [row({ objectKey: ignored, createdAtMs: OLD_ROW })],
      NOW,
      cfg,
    )
    const deletions = plan.actions.filter((a) => a.type === 'enqueue-deletion')
    expect(deletions).toEqual([])
  })
})

describe('canonicalization: several live rows for one key', () => {
  it('oldest row wins deterministically (independent of input order); losers → duplicate-row skip', () => {
    const a = row({ documentId: 'd_old', createdAtMs: OLD_ROW })
    const b = row({ documentId: 'd_new', createdAtMs: OLD_ROW + 5_000 })
    const forward = reconcilePlan([obj()], [a, b], NOW, cfg)
    const reversed = reconcilePlan([obj()], [b, a], NOW, cfg)
    expect(forward).toEqual(reversed) // order-independent
    expect(forward.skips).toContainEqual({ type: 'skip', reason: 'duplicate-row', objectKey: KEY, documentId: 'd_new' })
  })

  it('ties broken by documentId so the winner is stable', () => {
    const a = row({ documentId: 'aaa', createdAtMs: OLD_ROW })
    const b = row({ documentId: 'bbb', createdAtMs: OLD_ROW })
    const plan = reconcilePlan([obj({ etag: 'zzz' })], [b, a], NOW, cfg)
    const changed = plan.actions.find((x) => x.type === 'reingest-changed')
    expect(changed && 'documentId' in changed && changed.documentId).toBe('aaa')
  })
})

describe('determinism & ordering', () => {
  it('same inputs always produce the same plan (pure)', () => {
    const objects = [obj({ key: 'k/a.pdf', etag: 'e' }), obj({ key: 'k/b.pdf', etag: 'e' })]
    const rows = [row({ documentId: 'x', objectKey: 'k/c.pdf', createdAtMs: OLD_ROW })]
    expect(reconcilePlan(objects, rows, NOW, cfg)).toEqual(reconcilePlan(objects, rows, NOW, cfg))
  })

  it('actions are grouped by type (deletions first) then object key', () => {
    const objects = [
      obj({ key: 'k/new.pdf', etag: 'e' }), // ingest-new
      obj({ key: 'k/chg.pdf', etag: 'e2' }), // reingest-changed
    ]
    const rows = [
      row({ documentId: 'chg', objectKey: 'k/chg.pdf', recordedEtag: 'e1', status: 'completed', createdAtMs: OLD_ROW }),
      row({ documentId: 'del', objectKey: 'k/gone.pdf', createdAtMs: OLD_ROW }), // enqueue-deletion
    ]
    const plan = reconcilePlan(objects, rows, NOW, cfg)
    expect(plan.actions.map((a) => a.type)).toEqual(['enqueue-deletion', 'reingest-changed', 'ingest-new'])
  })
})

describe('summarizePlan', () => {
  it('counts actions and skips by kind', () => {
    const plan = reconcilePlan(
      [obj({ key: 'k/new.pdf' }), obj({ key: 'k/tmp.tmp' })],
      [row({ documentId: 'g', objectKey: 'k/gone.pdf', createdAtMs: OLD_ROW })],
      NOW,
      cfg,
    )
    expect(summarizePlan(plan)).toEqual({
      'ingest-new': 1,
      'enqueue-deletion': 1,
      'skip:ignored-name': 1,
    })
  })
})

describe('empty and no-op sweeps', () => {
  it('empty inputs → empty plan', () => {
    expect(reconcilePlan([], [], NOW, cfg)).toEqual({ actions: [], skips: [] })
  })

  it('a fully-converged prefix (all completed & unchanged) produces zero actions', () => {
    const objects = [obj({ key: 'k/a.pdf', etag: 'e' }), obj({ key: 'k/b.pdf', etag: 'e' })]
    const rows = [
      row({ documentId: 'a', objectKey: 'k/a.pdf', recordedEtag: 'e', status: 'completed' }),
      row({ documentId: 'b', objectKey: 'k/b.pdf', recordedEtag: 'e', status: 'completed' }),
    ]
    const plan = reconcilePlan(objects, rows, NOW, cfg)
    expect(plan.actions).toEqual([])
    expect(plan.skips.every((s) => s.reason === 'up-to-date')).toBe(true)
  })
})
