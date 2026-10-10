/**
 * @vitest-environment node
 */
/**
 * The reference-project catalog the agent sees every turn
 * (docs/design/cross-project-escalation.md): only CLOSED projects (every office
 * member reads them, so the catalog is safe in any chat), never the current
 * one, the most alike first with what they share, bounded, and nothing when
 * the office has none.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/projects/repository', () => ({ listProjectsInOrg: vi.fn(), findProjectInOrg: vi.fn() }))

import { REFERENCE_BRIEF_MAX, renderReferenceBrief } from './reference-brief'

function project(index: number, extra: Partial<Project> = {}, facts: Record<string, unknown> = {}): Project {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    organizationId: 'org_1',
    name: `Projekt ${index}`,
    createdBy: 'user_1',
    collectionName: `proj_${index}`,
    workosResourceId: null,
    profile: {
      facts: Object.fromEntries(
        Object.entries(facts).map(([key, value]) => [
          key,
          { value: value as string, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '' },
        ])
      ),
      goals: {},
      unknowns: [],
      assumptions: {},
    },
    profileVersion: 1,
    profilePromptView: null,
    profileDisplay: null,
    profileUpdatedAt: null,
    status: 'active',
    closedAt: null,
    closedBy: null,
    startedOn: null,
    endedOn: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  }
}

const closed = (index: number, extra: Partial<Project> = {}, facts: Record<string, unknown> = {}) =>
  project(index, { status: 'closed', closedAt: new Date('2021-06-01T00:00:00Z'), closedBy: 'user_1', ...extra }, facts)

describe('renderReferenceBrief', () => {
  it('lists only closed projects, never the current one, most alike first, with what they share', () => {
    const current = closed(1, {}, { bundesland: 'niederoesterreich', gebaeudeklasse: 4 })
    const brief = renderReferenceBrief(current, [
      current,
      project(2, {}, { bundesland: 'niederoesterreich', gebaeudeklasse: 4 }),
      closed(3, { startedOn: '2018-03-01', endedOn: '2020-11-01' }, { bundesland: 'wien', gebaeudeklasse: 4 }),
      closed(
        4,
        { profileDisplay: { title: 'P4', summary: 'Holzbau mit   Sicherheitstreppenhaus.', keyFacts: [], missingInfo: [] } },
        { bundesland: 'niederoesterreich', gebaeudeklasse: 4, bauweise: ['holzbau', 'stahlbeton'], vorhabensart: 'neubau' }
      ),
    ])!

    const lines = brief.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      // The intake's own labels, not its tokens: what the reader saw in the wizard.
      `- Projekt 4 (id ${project(4).id}): 2021, Niederösterreich, GK 4, Holzbau/Stahlbeton, Neubau · gemeinsam: Niederösterreich, GK 4 · Holzbau mit Sicherheitstreppenhaus.`
    )
    expect(lines[1]).toContain('Projekt 3')
    expect(lines[1]).toContain('2018–2020')
    expect(brief).not.toContain('Projekt 2')
    expect(brief).not.toContain('Projekt 1 ')
  })

  it('is bounded, and says how many more there are', () => {
    const many = Array.from({ length: REFERENCE_BRIEF_MAX + 3 }, (_, index) => closed(index + 10))
    const lines = renderReferenceBrief(null, many)!.split('\n')

    expect(lines).toHaveLength(REFERENCE_BRIEF_MAX + 1)
    expect(lines.at(-1)).toContain('3 weitere')
  })

  it('is null when the office has no closed project', () => {
    expect(renderReferenceBrief(null, [project(1), project(2)])).toBeNull()
  })
})
