/**
 * @vitest-environment node
 */
/**
 * The keyset page behind `GET /api/documents` and `GET /api/archiv/documents`.
 *
 * The listing used to be one page of 500, newest first, with nothing saying it
 * had stopped: the oldest plans of a big project were not in it, so search,
 * filters and the folder-upload planner worked on a corpus that was not the
 * project's. These pin the statement that replaced it: every query is still
 * bounded, one probe row answers "is there more", and the next page starts
 * strictly after the last row in `created_at DESC, id ASC` — compared at
 * MICROSECOND precision, which a JS `Date` cannot carry.
 *
 * Same pg-proxy harness as `version-repository.spec.ts`: a real query builder
 * over a callback driver that records the SQL instead of connecting.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

vi.mock('server-only', () => ({}))

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []
let answer: unknown[][] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: answer }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: (_scope: unknown, fn: () => unknown) => fn(),
  withOptionalTenant: (_scope: unknown, fn: () => unknown) => fn(),
}))

import {
  DOCUMENT_LIST_LIMIT,
  findProjectDocumentsByFilenames,
  findProjectDocumentsByNames,
  listProjectDocumentPage,
} from './repository'
import { FILENAME_LOOKUP_MAX_NAMES } from './filename-lookup'
import {
  findArchivDocumentsByFilenames,
  findArchivDocumentsByNames,
  listArchivDocuments,
} from '@/lib/archiv/repository'
import { decodeDocumentListCursor, encodeDocumentListCursor } from './list-cursor'

/** One row as pg-proxy returns it: the select's values, in column order. */
function wireRow(n: number, cursorCreatedAt = `2026-01-01T00:00:00.${String(n).padStart(6, '0')}`): unknown[] {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  return [
    id, // id
    `plan-${n}.pdf`, // filename
    null, // displayName
    100, // fileSize
    'application/pdf', // contentType
    'completed', // status
    'user', // authoredBy
    null, // publishedVersionId
    'active', // lifecycle
    'proj_c', // collectionName
    null, // folderId
    null, // originPath
    null, // contentHash
    '2026-01-01T00:00:00.000Z', // createdAt
    '2026-01-01T00:00:00.000Z', // updatedAt
    null, // errorMessage
    null, // metadata
    cursorCreatedAt, // cursorCreatedAt
  ]
}

function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

beforeEach(() => {
  captured.length = 0
  answer = []
})

describe('listProjectDocumentPage', () => {
  it('asks for one probe row past the page, never more than the cap', async () => {
    await listProjectDocumentPage('p1', 'org-1', { limit: 10_000 })
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/order by "documents"\."created_at" desc, "documents"\."id" asc/i)
    expect(sql).toMatch(/limit \$\d+$/i)
    expect(params.at(-1)).toBe(DOCUMENT_LIST_LIMIT + 1)
  })

  it('bounds a nonsense limit below as well', async () => {
    await listProjectDocumentPage('p1', 'org-1', { limit: -5 })
    expect(onlyQuery().params.at(-1)).toBe(2)
  })

  it('reports no next page when the probe row did not come back', async () => {
    answer = [wireRow(1), wireRow(2)]
    const page = await listProjectDocumentPage('p1', 'org-1', { limit: 2 })
    expect(page.rows).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  it('drops the probe row and points the cursor at the last row it kept', async () => {
    answer = [wireRow(1), wireRow(2), wireRow(3)]
    const page = await listProjectDocumentPage('p1', 'org-1', { limit: 2 })
    expect(page.rows.map((row) => row.filename)).toEqual(['plan-1.pdf', 'plan-2.pdf'])
    expect(page.nextCursor).toEqual({
      createdAt: '2026-01-01T00:00:00.000002',
      id: '00000000-0000-4000-8000-000000000002',
    })
    // The cursor column is the pager's, not the row's.
    expect(page.rows[0]).not.toHaveProperty('cursorCreatedAt')
    // Coerced at the boundary: a raw driver answer is text.
    expect(page.rows[0].createdAt).toBeInstanceOf(Date)
  })

  it('reads the cursor column at microsecond precision in UTC', async () => {
    await listProjectDocumentPage('p1', 'org-1')
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/to_char\(("documents"\.)?"created_at" AT TIME ZONE 'UTC', \$\d+\)/)
    expect(params).toContain('YYYY-MM-DD"T"HH24:MI:SS.US')
  })

  it('starts strictly after the cursor, with the id breaking a timestamp tie', async () => {
    const cursor = { createdAt: '2026-01-01T00:00:00.123456', id: '00000000-0000-4000-8000-000000000009' }
    await listProjectDocumentPage('p1', 'org-1', { cursor })
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(
      /"documents"\."created_at" < \(\$\d+::timestamp AT TIME ZONE 'UTC'\) OR \("documents"\."created_at" = \(\$\d+::timestamp AT TIME ZONE 'UTC'\) AND "documents"\."id" > \$\d+::uuid\)/,
    )
    expect(params).toEqual(expect.arrayContaining([cursor.createdAt, cursor.id]))
  })

  it('keeps the tenant and shelf predicates beside the cursor', async () => {
    await listProjectDocumentPage('p1', 'org-1', {
      cursor: { createdAt: '2026-01-01T00:00:00.000000', id: '00000000-0000-4000-8000-000000000001' },
    })
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"documents"\."project_id" = \$\d+/)
    expect(sql).toMatch(/"documents"\."organization_id" = \$\d+/)
    expect(sql).toMatch(/"documents"\."scope" = \$\d+/)
    expect(sql).toMatch(/"documents"\."lifecycle" = \$\d+/)
    expect(params).toEqual(expect.arrayContaining(['p1', 'org-1', 'project', 'active']))
  })
})

describe('listArchivDocuments', () => {
  it('pages the Archiv with the same order, bound and cursor', async () => {
    const cursor = { createdAt: '2026-01-01T00:00:00.000001', id: '00000000-0000-4000-8000-000000000001' }
    answer = [wireRow(1), wireRow(2)]
    const page = await listArchivDocuments('org-1', { cursor, limit: 1 })
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"documents"\."scope" = \$\d+/)
    expect(sql).toMatch(/order by "documents"\."created_at" desc, "documents"\."id" asc/i)
    expect(sql).toMatch(/"documents"\."id" > \$\d+::uuid/)
    expect(params).toEqual(expect.arrayContaining(['org-1', 'archiv', cursor.id]))
    expect(params.at(-1)).toBe(2)
    expect(page.rows).toHaveLength(1)
    expect(page.nextCursor?.id).toBe('00000000-0000-4000-8000-000000000001')
  })
})

describe('findArchivDocumentsByFilenames', () => {
  it('asks nothing for no names', async () => {
    expect(await findArchivDocumentsByFilenames('org-1', [])).toEqual([])
    expect(captured).toHaveLength(0)
  })

  it('looks the names up in both Unicode forms, bounded, inside the Archiv shelf', async () => {
    const composed = 'Übersicht.pdf'.normalize('NFC')
    await findArchivDocumentsByFilenames('org-1', [composed])
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"documents"\."filename" in \(\$\d+, \$\d+\)/)
    expect(params).toEqual(expect.arrayContaining([composed, composed.normalize('NFD'), 'archiv', 'org-1']))
    expect(params.at(-1)).toBe(DOCUMENT_LIST_LIMIT)
  })

  it('matches a name the reader spelled in another case', async () => {
    await findArchivDocumentsByFilenames('org-1', ['DETAIL.PDF'])
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/lower\("documents"\."filename"\) in/)
    expect(params).toEqual(expect.arrayContaining(['DETAIL.PDF', 'detail.pdf']))
  })
})

/**
 * The by-name lookup behind the search join and the citation resolve. It must
 * reach a document on any page of the listing, answer only what the listing
 * would show (this project's shelf, active rows), and stay bounded.
 */
describe('findProjectDocumentsByFilenames', () => {
  it('asks nothing for no names', async () => {
    expect(await findProjectDocumentsByFilenames('p1', 'org-1', ['', '  '])).toEqual([])
    expect(captured).toHaveLength(0)
  })

  it('matches the filename exactly or case-folded, on the listing\'s own shelf and lifecycle', async () => {
    const decomposed = 'Übersicht.PDF'.normalize('NFD')
    await findProjectDocumentsByFilenames('p1', 'org-1', [decomposed])
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"documents"\."project_id" = \$\d+/)
    expect(sql).toMatch(/"documents"\."scope" = \$\d+/)
    expect(sql).toMatch(/"documents"\."lifecycle" = \$\d+/)
    expect(sql).toMatch(/"documents"\."filename" in \(\$\d+, \$\d+\)/)
    expect(sql).toMatch(/lower\("documents"\."filename"\) in/)
    // Not the rename: this resolves the name the index and the model know.
    expect(sql).not.toMatch(/display_name"\) in/)
    const nfc = 'Übersicht.PDF'.normalize('NFC')
    expect(params).toEqual(
      expect.arrayContaining(['p1', 'org-1', 'project', 'active', nfc, nfc.normalize('NFD'), nfc.toLowerCase()]),
    )
    expect(params.at(-1)).toBe(DOCUMENT_LIST_LIMIT)
  })

  it('bounds how many names one query carries', async () => {
    const names = Array.from({ length: FILENAME_LOOKUP_MAX_NAMES + 50 }, (_, i) => `f${i}.pdf`)
    await findProjectDocumentsByFilenames('p1', 'org-1', names)
    const { params } = onlyQuery()
    expect(params).toContain(`f${FILENAME_LOOKUP_MAX_NAMES - 1}.pdf`)
    expect(params).not.toContain(`f${FILENAME_LOOKUP_MAX_NAMES}.pdf`)
  })
})

describe('the cursor codec', () => {
  const cursor = { createdAt: '2026-01-01T00:00:00.123456', id: '00000000-0000-4000-8000-000000000001' }

  it('round-trips', () => {
    expect(decodeDocumentListCursor(encodeDocumentListCursor(cursor))).toEqual(cursor)
  })

  it.each([
    ['garbage', 'not-a-cursor'],
    ['empty', ''],
    ['millisecond precision', Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.123', i: cursor.id })).toString('base64url')],
    ['a non-uuid id', Buffer.from(JSON.stringify({ t: cursor.createdAt, i: "1' OR 1=1" })).toString('base64url')],
    ['an oversized value', 'a'.repeat(500)],
  ])('refuses %s', (_label, encoded) => {
    expect(decodeDocumentListCursor(encoded)).toBeNull()
  })
})

/**
 * The upload planner's name probe. It must answer with exactly the rows the
 * upload would version: person-uploaded, ANY lifecycle (the unique index and
 * `findLiveDocumentByFilename` ignore it), by filename in either Unicode form,
 * plus the case-folded filename or rename the planner calls a `duplicate`.
 */
describe('findProjectDocumentsByNames', () => {
  it('matches identity and alias keys, person-uploaded rows, every lifecycle', async () => {
    const decomposed = 'Übersicht.pdf'.normalize('NFD')
    await findProjectDocumentsByNames('p1', 'org-1', [decomposed])
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"documents"\."authored_by" = \$\d+/)
    expect(sql).toMatch(/"documents"\."filename" in \(\$\d+, \$\d+\)/)
    expect(sql).toMatch(/lower\("documents"\."filename"\) in/)
    expect(sql).toMatch(/lower\("documents"\."display_name"\) in/)
    // Archived documents are versioned by the upload too, so none is filtered.
    expect(sql).not.toMatch(/"lifecycle" =/)
    const nfc = 'Übersicht.pdf'.normalize('NFC')
    expect(params).toEqual(
      expect.arrayContaining(['user', 'p1', 'org-1', 'project', nfc, nfc.normalize('NFD'), nfc.toLowerCase()]),
    )
  })

  it('splits a long probe into bounded queries and returns each row once', async () => {
    answer = [[
      '00000000-0000-4000-8000-000000000001', 'a.pdf', null, 1, null, null, 'user', 'active',
    ]]
    const names = Array.from({ length: 700 }, (_, i) => `f${i}.pdf`)
    const rows = await findProjectDocumentsByNames('p1', 'org-1', names)
    expect(captured).toHaveLength(2)
    for (const query of captured) expect(query.params.at(-1)).toBe(2000)
    // The same row answered both chunks; it is one document.
    expect(rows).toHaveLength(1)
  })
})

describe('findArchivDocumentsByNames', () => {
  it('probes the Archiv shelf the same way', async () => {
    await findArchivDocumentsByNames('org-1', ['EG.pdf'])
    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"documents"\."scope" = \$\d+/)
    expect(sql).toMatch(/lower\("documents"\."filename"\) in/)
    expect(sql).not.toMatch(/"lifecycle" =/)
    expect(params).toEqual(expect.arrayContaining(['org-1', 'archiv', 'user', 'EG.pdf', 'eg.pdf']))
  })
})
