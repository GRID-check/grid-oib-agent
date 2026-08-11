import { describe, expect, it } from 'vitest'
import {
  filterSlashCommands,
  findSlashCommandQuery,
  insertSlashCommand,
  resolveSlashInvocation,
} from './slash-command'

const SKILLS = [
  { name: 'oib-brandschutz', description: 'Prüft Brandschutzanforderungen nach OIB-Richtlinie 2.' },
  { name: 'oib-schallschutz', description: 'Prüft Schallschutz nach OIB-Richtlinie 5.' },
  { name: 'projekt-zusammenfassung', description: 'Fasst den Projektstand zusammen. Brandschutz inklusive.' },
]
const NAMES = SKILLS.map((skill) => skill.name)

describe('findSlashCommandQuery', () => {
  it('opens on a leading slash and reports the fragment under the caret', () => {
    expect(findSlashCommandQuery('/oib', 4)).toEqual({ query: 'oib', start: 0, end: 4 })
  })

  it('opens on the bare slash, so the full menu shows before anything is typed', () => {
    expect(findSlashCommandQuery('/', 1)).toEqual({ query: '', start: 0, end: 1 })
  })

  it('tolerates leading whitespace', () => {
    expect(findSlashCommandQuery('  /oib', 6)).toEqual({ query: 'oib', start: 2, end: 6 })
  })

  it('closes once the token ends, so typing the request does not reopen it', () => {
    expect(findSlashCommandQuery('/oib-brandschutz Stiegenhaus', 28)).toBeNull()
  })

  it('does not fire mid-sentence — the domain is full of slashes', () => {
    // Every one of these is ordinary text a user writes about a Richtlinie.
    expect(findSlashCommandQuery('gilt am 12/05 noch?', 13)).toBeNull()
    expect(findSlashCommandQuery('siehe OIB-RL 2/3', 16)).toBeNull()
    expect(findSlashCommandQuery('und/oder', 8)).toBeNull()
    expect(findSlashCommandQuery('Grenzwert in m/s', 16)).toBeNull()
    expect(findSlashCommandQuery('Pfad /etc/hosts', 15)).toBeNull()
  })

  it('is null when the caret sits on or before the slash', () => {
    expect(findSlashCommandQuery('/oib', 0)).toBeNull()
  })

  it('gives up past the spec name limit rather than scanning prose', () => {
    expect(findSlashCommandQuery(`/${'a'.repeat(65)}`, 66)).toBeNull()
  })
})

describe('insertSlashCommand', () => {
  it('replaces the fragment and leaves the caret past a trailing space', () => {
    const range = findSlashCommandQuery('/oib', 4)!
    expect(insertSlashCommand('/oib', range, 'oib-brandschutz')).toEqual({
      text: '/oib-brandschutz ',
      caret: 17,
    })
  })

  it('keeps the rest of the message and does not double the gap', () => {
    const range = findSlashCommandQuery('/oib Stiegenhaus prüfen', 4)!
    expect(insertSlashCommand('/oib Stiegenhaus prüfen', range, 'oib-brandschutz')).toEqual({
      text: '/oib-brandschutz Stiegenhaus prüfen',
      caret: 16,
    })
  })
})

describe('resolveSlashInvocation', () => {
  it('resolves a known skill and reports the argument after it', () => {
    expect(resolveSlashInvocation('/oib-brandschutz Stiegenhaus prüfen', NAMES)).toEqual({
      skillName: 'oib-brandschutz',
      argument: 'Stiegenhaus prüfen',
    })
  })

  it('resolves a bare invocation — the skill body is the instruction', () => {
    expect(resolveSlashInvocation('/oib-brandschutz', NAMES)).toEqual({
      skillName: 'oib-brandschutz',
      argument: '',
    })
  })

  it('never invents a skill from text that merely starts with a slash', () => {
    expect(resolveSlashInvocation('/etc/passwd ist gemeint', NAMES)).toBeNull()
    expect(resolveSlashInvocation('/unbekannt', NAMES)).toBeNull()
  })

  it('does not repair case — skill names are lowercase by construction', () => {
    expect(resolveSlashInvocation('/OIB-Brandschutz', NAMES)).toBeNull()
  })

  it('is null for ordinary prose', () => {
    expect(resolveSlashInvocation('Was gilt für und/oder?', NAMES)).toBeNull()
    expect(resolveSlashInvocation('', NAMES)).toBeNull()
  })

  it('matches the longer name, not a prefix of it', () => {
    // `/oib-schallschutz` must not resolve to `oib-brandschutz` or vice versa;
    // the token is delimited by whitespace, so this is exact by construction.
    expect(resolveSlashInvocation('/oib-schallschutz', NAMES)?.skillName).toBe('oib-schallschutz')
  })
})

describe('filterSlashCommands', () => {
  it('returns everything for an empty fragment', () => {
    expect(filterSlashCommands(SKILLS, '')).toHaveLength(3)
  })

  it('ranks a name prefix above a name substring above a description match', () => {
    const ranked = filterSlashCommands(SKILLS, 'brandschutz')
    expect(ranked.map((skill) => skill.name)).toEqual([
      // substring of the name…
      'oib-brandschutz',
      // …then the one that only mentions it in its description.
      'projekt-zusammenfassung',
    ])
  })

  it('prefers the prefix match', () => {
    const ranked = filterSlashCommands(SKILLS, 'oib')
    expect(ranked.slice(0, 2).map((skill) => skill.name)).toEqual([
      'oib-brandschutz',
      'oib-schallschutz',
    ])
  })

  it('is case-insensitive on the way in', () => {
    expect(filterSlashCommands(SKILLS, 'BRAND').map((s) => s.name)).toContain('oib-brandschutz')
  })

  it('keeps the caller order within a rank, so the menu does not reshuffle', () => {
    expect(filterSlashCommands(SKILLS, 'oib').map((s) => s.name)).toEqual([
      'oib-brandschutz',
      'oib-schallschutz',
    ])
  })
})
