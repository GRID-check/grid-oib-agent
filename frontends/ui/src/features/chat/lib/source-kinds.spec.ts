/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import {
  AGENT_AUTHORED_LANE,
  AGENT_AUTHORED_LANE_LABEL,
  MAIL_LANE,
  MAIL_LANE_LABEL,
  OFFICE_MAIL_LANE,
  KIND_TO_SIGNAL,
  CITATION_KEY_QUALIFIERS,
  SHELVES,
  accentForLane,
  asShelf,
  asSourceKind,
  authorityTag,
  kindForLane,
  modernizeLane,
  modernizeSourceKind,
  scopeForQualifier,
  type Shelf,
  type SourceKind,
} from './source-kinds'

describe('asSourceKind', () => {
  test('accepts the four canonical kinds', () => {
    for (const k of ['building_law', 'office', 'project', 'web'] as SourceKind[]) {
      expect(asSourceKind(k)).toBe(k)
    }
  })

  test('rejects unknown / empty values', () => {
    expect(asSourceKind('law')).toBeUndefined()
    expect(asSourceKind('')).toBeUndefined()
    expect(asSourceKind(null)).toBeUndefined()
    expect(asSourceKind(undefined)).toBeUndefined()
  })
})

describe('KIND_TO_SIGNAL', () => {
  test('maps the OIB corpus + RIS (building_law) to the law tint family', () => {
    expect(KIND_TO_SIGNAL.building_law).toBe('law')
  })

  test('maps office/project/web to their families', () => {
    expect(KIND_TO_SIGNAL.office).toBe('office')
    expect(KIND_TO_SIGNAL.project).toBe('project')
    expect(KIND_TO_SIGNAL.web).toBe('auto')
  })
})

describe('the German spellings a stored citation or lane still carries', () => {
  test('a kind reads as its English name', () => {
    expect(modernizeSourceKind('baurecht')).toBe('building_law')
    expect(modernizeSourceKind('buero')).toBe('office')
    expect(modernizeSourceKind('projekt')).toBe('project')
    expect(modernizeSourceKind('messung')).toBe('measurement')
    expect(modernizeSourceKind('web')).toBe('web')
    expect(asSourceKind(modernizeSourceKind('baurecht'))).toBe('building_law')
  })

  test('a lane reads as its English key, and still means the same kind and tag', () => {
    expect(modernizeLane('baurecht_oib_leitfaden')).toBe('building_law_oib_guide')
    expect(modernizeLane('buero_piloti')).toBe('office_piloti')
    expect(modernizeLane('norm_extern')).toBe('external_standard')
    expect(kindForLane('baurecht_land')).toBe('building_law')
    expect(kindForLane('behoerde')).toBe('building_law')
    expect(authorityTag('norm_extern')).toBe('ÖNORM')
    expect(authorityTag('baurecht_oib')).toBe('OIB')
    expect(modernizeLane('building_law_oib')).toBe('building_law_oib')
  })
})

describe('authorityTag', () => {
  test('distinguishes OIB from RIS within the Baurecht family', () => {
    expect(authorityTag('building_law_oib')).toBe('OIB')
    expect(authorityTag('building_law_oib_guide')).toBe('OIB')
    expect(authorityTag('building_law_ris')).toBe('RIS')
    expect(authorityTag('building_law_federal')).toBe('RIS')
    expect(authorityTag('building_law_ordinance')).toBe('RIS')
  })

  test('tags external norms and authority info distinctly', () => {
    expect(authorityTag('external_standard')).toBe('ÖNORM')
    expect(authorityTag('authority')).toBe('Behörde')
  })

  test('office/project/web carry no authority tag', () => {
    expect(authorityTag('office')).toBeNull()
    expect(authorityTag('project')).toBeNull()
    expect(authorityTag('web')).toBeNull()
    expect(authorityTag(null)).toBeNull()
  })

  test('an unclassified document does not claim to be an Austrian legal source', () => {
    // `building_law_base` is the lane of the DEFAULT doc_class — nobody has
    // classified this document yet. Inheriting the `building_law` prefix's RIS
    // badge would let any upload wear the strongest provenance claim the UI
    // can make.
    expect(authorityTag('building_law_base')).toBeNull()
  })
})

describe('the agent-authored lane', () => {
  test('is a sub-label inside the office kind, never a kind of its own', () => {
    // A published Piloti document IS office knowledge — it paints in the office
    // colour. What the lane adds is who wrote it.
    expect(AGENT_AUTHORED_LANE).toBe('office_piloti')
    expect(kindForLane(AGENT_AUTHORED_LANE)).toBe('office')
    expect(asSourceKind(AGENT_AUTHORED_LANE)).toBeUndefined()
  })

  test('its label names the document kind and no approver', () => {
    // Who approved it, and when, arrive as data on the source payload and are
    // appended by the renderer — the taxonomy is not a sentence with a hole.
    expect(AGENT_AUTHORED_LANE_LABEL).toBe('Piloti-Dokument')
    expect(AGENT_AUTHORED_LANE_LABEL).not.toContain('{')
  })

  test('carries no authority tag — it is not a rung of the legal ladder', () => {
    expect(authorityTag(AGENT_AUTHORED_LANE)).toBeNull()
  })
})

describe('the mail lanes', () => {
  test("are sub-labels inside the shelf's kind, never a kind of their own", () => {
    // A filed E-Mail-Verlauf is project (or office) knowledge; the lane says it is mail.
    expect(MAIL_LANE).toBe('project_mail')
    expect(OFFICE_MAIL_LANE).toBe('office_mail')
    expect(kindForLane(MAIL_LANE)).toBe('project')
    expect(kindForLane(OFFICE_MAIL_LANE)).toBe('office')
    expect(asSourceKind(MAIL_LANE)).toBeUndefined()
    expect(MAIL_LANE_LABEL).toBe('E-Mail')
  })

  test('carry no authority tag, whoever sent the mail', () => {
    // A clerk's e-mail from a Behörde's domain is not a Bescheid: no `Behörde` badge, no law colour.
    expect(authorityTag(MAIL_LANE)).toBeNull()
    expect(authorityTag(OFFICE_MAIL_LANE)).toBeNull()
    expect(accentForLane(MAIL_LANE, 'project')).toBe('project')
  })
})

describe('Shelf (ADR-0047)', () => {
  test('is exactly the four wire shelves', () => {
    expect([...SHELVES]).toEqual(['office_shelf', 'project', 'session', 'base'])
  })

  test('accepts a shelf the wire states, case- and whitespace-tolerantly', () => {
    for (const shelf of SHELVES) expect(asShelf(shelf)).toBe(shelf)
    expect(asShelf(' Session ')).toBe('session')
  })

  test('an unknown or missing shelf is UNKNOWN — never a default', () => {
    // The predecessor of this narrowing (`collectionScope`) failed OPEN and
    // returned `building_law`, so an unrecognised collection claimed to be
    // authoritative base law. Unknown must stay unknown.
    expect(asShelf('building_law')).toBeUndefined()
    expect(asShelf('projekt')).toBeUndefined()
    expect(asShelf('archiv_org1')).toBeUndefined()
    expect(asShelf('')).toBeUndefined()
    expect(asShelf(null)).toBeUndefined()
    expect(asShelf(undefined)).toBeUndefined()
  })
})

describe('the shelf labels in the dictionary', () => {
  // The labels live in `chat.sourceTabs.shelves` (rendering only, ADR-0047 §5)
  // and are resolved where the card renders; this pins the two invariants the
  // old German table pinned.
  test('every shelf has a distinct label, in both languages', () => {
    for (const dictionary of [de.chat.sourceTabs.shelves, en.chat.sourceTabs.shelves]) {
      const labels = SHELVES.map((shelf: Shelf) => dictionary[shelf])
      expect(labels.every((label) => typeof label === 'string' && label.length > 0)).toBe(true)
      expect(new Set(labels).size).toBe(SHELVES.length)
    }
  })

  test('a private session attachment is NOT labelled as project knowledge', () => {
    // The headline defect: a file the user attached to one chat was told to the
    // user as a "Private Sitzung" and then cited as project knowledge.
    expect(de.chat.sourceTabs.shelves.session).toBe('Private Sitzung')
    expect(de.chat.sourceTabs.shelves.session).not.toBe(de.chat.sourceTabs.shelves.project)
  })
})

describe('scopeForQualifier (citation keys — the versioned fallback)', () => {
  test('every qualifier a writer can emit parses back to its shelf', () => {
    for (const [qualifier, shelf] of CITATION_KEY_QUALIFIERS) {
      expect(scopeForQualifier(qualifier)).toBe(shelf)
    }
    // The three legacy strings, which keys already persisted still carry, plus
    // the one ADR-0047 added: the backend appends a qualifier to keep a key
    // unique when two shelves hold the same filename, so a session hit writes
    // `(Private Sitzung)`. A reader that knew only the legacy three would leave
    // that qualifier in the filename and lose the citation entirely. The last
    // row is the archiv shelf's retired name, read and never written.
    expect(CITATION_KEY_QUALIFIERS.map(([, shelf]) => shelf)).toEqual([
      'office_shelf',
      'project',
      'base',
      'session',
      'office_shelf',
    ])
  })

  test('the archiv shelf is written „Büroablage" and still read under its old name', () => {
    expect(CITATION_KEY_QUALIFIERS[0]).toEqual(['Büroablage', 'office_shelf'])
    expect(scopeForQualifier('Büroablage')).toBe('office_shelf')
    expect(scopeForQualifier('Büroarchiv')).toBe('office_shelf')
  })

  test('the shelf label the reader sees is the qualifier the backend writes', () => {
    // `chat.sourceTabs.shelves` renders the shelf; the qualifier is pinned to
    // the backend's `SHELF_QUALIFIERS`. One name for one shelf on both sides.
    expect(de.chat.sourceTabs.shelves.office_shelf).toBe(CITATION_KEY_QUALIFIERS[0][0])
    expect(en.chat.sourceTabs.shelves.office_shelf).toBe('Office filing')
  })

  test('every shelf is reachable from a key, so no key can go unread', () => {
    const qualified = new Set(CITATION_KEY_QUALIFIERS.map(([, shelf]) => shelf))
    for (const shelf of SHELVES) expect(qualified.has(shelf)).toBe(true)
  })

  test('qualifiers are matched case-insensitively', () => {
    // The qualifier survives a round trip through an LLM, which may recase it.
    expect(scopeForQualifier('projektwissen')).toBe('project')
    expect(scopeForQualifier('  BÜROARCHIV  ')).toBe('office_shelf')
    expect(scopeForQualifier('private sitzung')).toBe('session')
    expect(scopeForQualifier('Internal')).toBeUndefined()
    expect(scopeForQualifier('')).toBeUndefined()
    expect(scopeForQualifier(null)).toBeUndefined()
  })
})
