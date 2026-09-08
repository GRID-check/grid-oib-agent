/**
 * @vitest-environment node
 */

/**
 * The Herleitung's level grouping. Three properties carry the whole design:
 * the order is fixed, the EMPTY levels survive, and two projects stay two.
 *
 * The third is the one that has teeth. Everything else in this file would still
 * pass if a project-shelf hit were filed under "the project we happen to have",
 * which is the prefix-guess ADR-0047 removed — so the unattributed case is
 * asserted explicitly rather than left to the happy path.
 */

import { describe, expect, it } from 'vitest'
import { KNOWLEDGE_LEVEL_ORDER, groupByLevel, levelForHit } from './herleitung-levels'
import type { CitedDocument } from './citations'
import type { TraceLaneCard } from './trace-lanes'

const lane = (over: Partial<TraceLaneCard> = {}): TraceLaneCard => ({
  key: 'baurecht_oib',
  label: 'OIB-Richtlinie',
  hitCount: 1,
  sources: [],
  signal: 'law',
  ...over,
})

const doc = (over: Partial<CitedDocument>): CitedDocument => ({
  id: over.id ?? 'd',
  title: over.title ?? 'Doc',
  kind: 'projekt',
  tint: 'project',
  loci: [],
  ...over,
})

describe('the order', () => {
  it('is law → office → register → project → conversation → web, always', () => {
    expect(KNOWLEDGE_LEVEL_ORDER).toEqual([
      'law',
      'office',
      'register',
      'project',
      'conversation',
      'web',
    ])
    expect(groupByLevel([]).map((group) => group.level)).toEqual([...KNOWLEDGE_LEVEL_ORDER])
  })

  it('renders every level even when the turn read nothing at all', () => {
    const groups = groupByLevel([])
    expect(groups).toHaveLength(6)
    expect(groups.every((group) => group.hitCount === 0)).toBe(true)
  })
})

describe('placing a hit', () => {
  it('takes the SHELF the backend stated, for every shelf', () => {
    const cases = [
      ['base', 'law'],
      ['archiv', 'office'],
      ['register', 'register'],
      ['project', 'project'],
      ['session', 'conversation'],
    ] as const
    for (const [shelf, level] of cases) {
      expect(levelForHit({ shelf }, { key: 'x', kind: undefined })).toBe(level)
    }
  })

  it('falls back to the lane only where the lane actually determines a level', () => {
    expect(levelForHit({}, { key: 'baurecht_oib', kind: 'baurecht' })).toBe('law')
    expect(levelForHit({}, { key: 'web', kind: 'web' })).toBe('web')
    expect(levelForHit({}, { key: 'buero', kind: 'buero' })).toBe('office')
  })

  it('files a shelf-less Projektwissen lane under Projekt — the fan says so too', () => {
    // Not the prefix guess ADR-0047 removed: the lane is the backend's own
    // classification, and it is printed on the fan card for this same hit. The
    // shelf still wins wherever it exists, which is what keeps a private
    // session attachment out of Projektwissen.
    expect(levelForHit({}, { key: 'projekt', kind: 'projekt' })).toBe('project')
    expect(levelForHit({ shelf: 'session' }, { key: 'projekt', kind: 'projekt' })).toBe(
      'conversation'
    )
  })

  it('reaches no level for a measurement — nothing was read', () => {
    expect(levelForHit({}, { key: 'messung', kind: 'messung' })).toBeNull()
  })
})

describe('the project level', () => {
  const lanes = [
    lane({
      key: 'projekt',
      label: 'Projektwissen',
      signal: 'project',
      kind: 'projekt',
      hitCount: 3,
      sources: [
        { name: 'Brandschutz.pdf', shelf: 'project' },
        { name: 'Statik.pdf', shelf: 'project' },
        { name: 'Unbekannt.pdf', shelf: 'project' },
      ],
    }),
  ]
  const documents = [
    doc({ id: 'a', fileName: 'Brandschutz.pdf', projectId: 'p1', projectName: 'Seestadt Nord' }),
    doc({ id: 'b', fileName: 'Statik.pdf', projectId: 'p2', projectName: 'Rosenhügel' }),
  ]

  it('keeps two projects apart, one subgroup each', () => {
    const project = groupByLevel(lanes, documents).find((group) => group.level === 'project')
    expect(project?.hitCount).toBe(3)
    expect(project?.projects.map((sub) => sub.projectName)).toEqual([
      'Seestadt Nord',
      'Rosenhügel',
      null,
    ])
  })

  it('leaves a hit no document identifies unattributed rather than guessing', () => {
    const project = groupByLevel(lanes, documents).find((group) => group.level === 'project')
    const orphan = project?.projects.find((sub) => sub.projectId === null)
    expect(orphan?.entries.map((entry) => entry.name)).toEqual(['Unbekannt.pdf'])
  })
})

describe('deduplication', () => {
  it('counts a document reached by two lanes once — it was read once', () => {
    const groups = groupByLevel([
      lane({ sources: [{ name: 'oib-rl_2.pdf', shelf: 'base' }] }),
      lane({
        key: 'baurecht_ris',
        label: 'Rechtsquelle (RIS)',
        sources: [{ name: 'oib-rl_2.pdf', shelf: 'base' }],
      }),
    ])
    const law = groups.find((group) => group.level === 'law')
    expect(law?.hitCount).toBe(1)
    expect(law?.entries).toHaveLength(1)
  })
})
