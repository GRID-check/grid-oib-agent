/**
 * @vitest-environment node
 */
/**
 * One fact, one live row — the memory service's write-time consolidation
 * against a REAL Postgres with the full migration chain applied.
 *
 * `createProjectMemoryItem` has three paths that each used to leave a second
 * live row for a fact the store already held: the exact duplicate, the
 * paraphrase, and a caller-named supersede target that was dropped once the
 * finding merged into a paraphrase (PR #602). The unit spec beside this file
 * mocks the repository, so it can show which statements the service builds and
 * cannot show what the table holds afterwards, which is the whole claim. This
 * suite counts rows.
 *
 * It also runs the semantic gate through the real driver. That gate is raw SQL
 * over `grid_cosine_similarity`, and a mocked `execute` returns whatever shape
 * the spec author expected; only a real result shows what postgres-js hands
 * back. The embedder itself is stubbed deterministically — the backend is not
 * part of this harness, and the claim under test is what the service does with
 * a near-identical vector, not how one is produced.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/memory-service.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs
 * this file alongside the isolation and BIM suites.
 */

import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectMemory } from '@/lib/db/schema'
import type { ProjectMemoryItem } from '@/lib/db/schema'
import {
  NEAR_DUP_JACCARD_THRESHOLD,
  contentTokens,
  jaccardSimilarity,
  polaritySignature,
} from '@/lib/knowledge/consolidation'

vi.mock('server-only', () => ({}))

// Pure helpers stay real; only the network-reaching embed calls are stubbed,
// exactly as the unit spec does. Each case decides whether an embedder exists.
vi.mock('@/lib/knowledge/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge/embeddings')>()
  return { ...actual, embedNote: vi.fn(async () => null), embedNotes: vi.fn(async () => null) }
})

import { embedNote } from '@/lib/knowledge/embeddings'

const url = process.env.GRID_TEST_DATABASE_URL

const ORG = `org_memory_${Date.now()}`
const USER = `user_${ORG}`

const FINGERPRINT = 'integration-test-embedder'
const DIMENSIONS = 8

/**
 * Each topic owns one axis of the vector space, so two findings about the same
 * subject are near-identical and findings about different subjects are
 * orthogonal. A hash of the text jitters a spare axis, which keeps two
 * paraphrases at cosine ≈ 0.99 rather than exactly 1.0 — the gate is a
 * threshold, and equal vectors would also pass a gate that only checked
 * equality.
 */
const TOPIC_AXES: ReadonlyArray<readonly [RegExp, number]> = [
  [/flachdach/i, 0],
  [/smoke extraction/i, 1],
  [/pressuris/i, 2],
]

function hashOf(text: string): number {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash
}

function topicVector(text: string): number[] {
  const axis = TOPIC_AXES.find(([pattern]) => pattern.test(text))?.[1] ?? DIMENSIONS - 1
  const vector = new Array<number>(DIMENSIONS).fill(0)
  vector[axis] = 1
  vector[DIMENSIONS - 2] = 0.05 + (hashOf(text) % 100) / 2000
  return vector
}

/** Wire the deterministic embedder in; `null` is the no-embedder deployment. */
function useEmbedder(): void {
  vi.mocked(embedNote).mockImplementation(async (text) => ({
    vector: topicVector(text),
    fingerprint: FINGERPRINT,
  }))
}

/**
 * The suite below is opt-in and `describe.skipIf` exits 0 when it skips, which
 * would make a green tenant-isolation job indistinguishable from one that ran
 * nothing. The job sets the marker (not `CI`: the unit shards also own this
 * file and have no database), so the job that promises a database is the one
 * that fails when it stops providing one.
 */
describe('the memory consolidation suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so the ' +
        'memory consolidation suite skipped and nothing verified "one fact, one live row". ' +
        'Check `task db:test:rls`.'
    ).toBeTruthy()
  })
})

describe.skipIf(!url)('memory consolidation against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let createProjectMemoryItem: typeof import('./memory-service').createProjectMemoryItem

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: USER }, run)

  /** A fresh project per case, so a row count is a statement about that case alone. */
  async function seedProject(name: string): Promise<string> {
    const rows = await inTenant(() =>
      db.execute(
        sql`insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG}, ${name}, ${USER}, ${`coll_${name}`})
            returning id`
      )
    )
    return String([...rows][0].id)
  }

  const rowsOf = (projectId: string): Promise<ProjectMemoryItem[]> =>
    inTenant(() => db.select().from(projectMemory).where(eq(projectMemory.projectId, projectId)))

  const live = (rows: ProjectMemoryItem[]): ProjectMemoryItem[] =>
    rows.filter((row) => row.status === 'active')

  const remember = (
    projectId: string,
    kind: ProjectMemoryItem['kind'],
    content: string,
    options: Parameters<typeof createProjectMemoryItem>[1] = {}
  ): Promise<ProjectMemoryItem> =>
    inTenant(() =>
      createProjectMemoryItem(
        { scope: 'project', projectId, organizationId: ORG, kind, content },
        options
      )
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    createProjectMemoryItem = (await import('./memory-service')).createProjectMemoryItem

    await withPlatformAccess('test seed: create the organization', () =>
      db.execute(
        sql`insert into organizations (workos_organization_id, display_name)
            values (${ORG}, ${ORG}) on conflict do nothing`
      )
    )
  })

  afterEach(() => {
    vi.mocked(embedNote).mockReset()
    vi.mocked(embedNote).mockResolvedValue(null)
  })

  afterAll(async () => {
    // `beforeAll` may have thrown before `db` was assigned; a TypeError here
    // would replace the setup failure that is worth reading.
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from project_memory where organization_id = ${ORG}`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
      await db.execute(sql`delete from organizations where workos_organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('writes the same fact twice into one live row', async () => {
    const projectId = await seedProject('exact')
    const content = 'Die Gebäudeklasse ist GK 4'

    const first = await remember(projectId, 'derived_fact', content)
    const second = await remember(projectId, 'derived_fact', content)

    const rows = await rowsOf(projectId)
    expect(rows).toHaveLength(1)
    expect(live(rows).map((row) => row.id)).toEqual([first.id])
    expect(second.id).toBe(first.id)
  })

  it('merges a paraphrase the embedder recognises into the existing row, across kinds', async () => {
    useEmbedder()
    const projectId = await seedProject('paraphrase')
    const stated = 'Der Bauherr wünscht ein Flachdach'
    const restated = 'Flachdach ist gewünscht'

    // The lexical gate cannot see this pair (the design's own example), so a
    // single live row below is the SEMANTIC gate's doing, not Jaccard's.
    expect(jaccardSimilarity(contentTokens(stated), contentTokens(restated))).toBeLessThan(
      NEAR_DUP_JACCARD_THRESHOLD
    )
    expect(polaritySignature(stated)).toBe(polaritySignature(restated))

    const first = await remember(projectId, 'constraint', stated)
    const second = await remember(projectId, 'derived_fact', restated)

    const rows = await rowsOf(projectId)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.id)
    expect(second.id).toBe(first.id)
    // The vector the gate compared against was stored with the first write.
    expect(rows[0].embeddingModel).toBe(FINGERPRINT)
  })

  it('supersedes rather than merges when the paraphrase says the opposite', async () => {
    useEmbedder()
    const projectId = await seedProject('correction')
    const claim = 'Der Bauherr wünscht ein Flachdach'
    const correction = 'Der Bauherr wünscht kein Flachdach'
    expect(polaritySignature(claim)).not.toBe(polaritySignature(correction))

    const stale = await remember(projectId, 'constraint', claim)
    const retired: string[] = []
    const current = await remember(projectId, 'constraint', correction, {
      onSuperseded: (id) => retired.push(id),
    })

    const rows = await rowsOf(projectId)
    expect(rows).toHaveLength(2)
    expect(live(rows).map((row) => row.id)).toEqual([current.id])
    expect(current.supersedesId).toBe(stale.id)
    expect(rows.find((row) => row.id === stale.id)?.status).toBe('superseded')
    expect(retired).toEqual([stale.id])
  })

  it('retires the named target even when the finding merges into a paraphrase', async () => {
    useEmbedder()
    const projectId = await seedProject('named')
    const existing = await remember(
      projectId,
      'derived_fact',
      'Natural smoke extraction was approved for the stairwell'
    )
    const stale = await remember(
      projectId,
      'constraint',
      'The stairwell must be pressurised (Druckbelueftung)'
    )
    expect(live(await rowsOf(projectId))).toHaveLength(2)

    const retired: string[] = []
    const merged = await remember(
      projectId,
      'derived_fact',
      'Natural smoke extraction was approved for the stairwell instead',
      {
        supersedesContent: 'The stairwell must be pressurised (Druckbelueftung)',
        onSuperseded: (id) => retired.push(id),
      }
    )

    const rows = await rowsOf(projectId)
    expect(rows).toHaveLength(2)
    expect(merged.id).toBe(existing.id)
    expect(live(rows).map((row) => row.id)).toEqual([existing.id])
    expect(rows.find((row) => row.id === stale.id)?.status).toBe('superseded')
    expect(retired).toEqual([stale.id])
  })
})
