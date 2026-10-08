/**
 * @vitest-environment node
 *
 * The placement sweep's walk over the projects that restrict a folder
 * (ADR-0087): every project is reached however many there are, within a
 * bounded number of projects and a time budget per sweep. The repository is an
 * in-memory list here; `collection-placement.integration.spec.ts` runs the same
 * walk against Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestrictedProjectsPage } from '@/lib/authz/folder-access-repository'
import type { PlacementResult } from './collection-placement'

vi.mock('server-only', () => ({}))

const listProjects = vi.fn<(page: RestrictedProjectsPage) => Promise<Array<{ organizationId: string; projectId: string }>>>()
const place = vi.fn<(organizationId: string, projectId: string) => Promise<PlacementResult>>()

vi.mock('@/lib/authz/folder-access-repository', () => ({
  listProjectsWithRestrictedFolders: (page: RestrictedProjectsPage) => listProjects(page),
}))
vi.mock('./collection-placement', () => ({
  retryProjectPlacement: (organizationId: string, projectId: string) => place(organizationId, projectId),
}))

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/** The repository's contract over a fixed set of project ids, as Postgres answers it. */
function serve(ids: string[]): void {
  const sorted = [...ids].sort()
  listProjects.mockImplementation(async ({ after, upTo, limit }) =>
    sorted
      .filter((id) => (after === null || id > after) && (upTo === null || id <= upTo))
      .slice(0, limit)
      .map((projectId) => ({ organizationId: 'org', projectId }))
  )
}

async function loadSweep(): Promise<typeof import('./placement-sweep')> {
  vi.resetModules()
  return import('./placement-sweep')
}

describe('sweepCollectionPlacement', () => {
  beforeEach(() => {
    listProjects.mockReset()
    place.mockReset()
    place.mockResolvedValue({ moved: 0, failed: [], pending: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reaches every project, however many restrict a folder, a page per sweep', async () => {
    const sweep = await loadSweep()
    const ids = Array.from({ length: sweep.PLACEMENT_SWEEP_PROJECTS * 2 + 7 }, (_, i) => uuid(i + 1))
    serve(ids)

    const sweeps = Math.ceil(ids.length / sweep.PLACEMENT_SWEEP_PROJECTS)
    const checked: number[] = []
    for (let i = 0; i < sweeps; i++) checked.push((await sweep.sweepCollectionPlacement()).checked)

    const placed = place.mock.calls.map(([, projectId]) => projectId)
    expect(new Set(placed)).toEqual(new Set(ids))
    // One lap places each project once, then the walk starts round again.
    expect(placed.slice(0, ids.length).sort()).toEqual([...ids].sort())
    expect(checked.every((count) => count <= sweep.PLACEMENT_SWEEP_PROJECTS)).toBe(true)
  })

  it('wraps round when the cursor is past the last project', async () => {
    const sweep = await loadSweep()
    serve([uuid(1), uuid(2), uuid(3)])

    const swept = await sweep.sweepCollectionPlacement()

    expect(swept.checked).toBe(3)
    expect(new Set(place.mock.calls.map(([, projectId]) => projectId))).toEqual(new Set([uuid(1), uuid(2), uuid(3)]))
  })

  it('starts no project after its time budget, and the next sweep carries on from there', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const sweep = await loadSweep()
    serve([uuid(1), uuid(2), uuid(3), uuid(4)])
    const perProject = Math.ceil(sweep.PLACEMENT_SWEEP_BUDGET_MS / 2) + 1
    place.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + perProject)
      return { moved: 0, failed: [], pending: 0 }
    })

    const first = await sweep.sweepCollectionPlacement()
    const second = await sweep.sweepCollectionPlacement()

    expect([first.checked, second.checked]).toEqual([2, 2])
    expect(new Set(place.mock.calls.map(([, projectId]) => projectId)).size).toBe(4)
  })

  it('counts what is left in the wrong collection, and carries on past a project that throws', async () => {
    const sweep = await loadSweep()
    serve([uuid(1), uuid(2), uuid(3)])
    place.mockImplementation(async (_org, projectId) => {
      if (projectId === uuid(2)) throw new Error('database gone')
      return { moved: 2, failed: ['doc-x'], pending: 3 }
    })

    expect(await sweep.sweepCollectionPlacement()).toEqual({ checked: 3, moved: 4, pending: 8, failed: 1 })
  })
})
