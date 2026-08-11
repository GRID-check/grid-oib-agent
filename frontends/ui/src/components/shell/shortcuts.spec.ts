/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'

import { railSections, paletteSections } from './project-sections'
import {
  jumpTargets,
  isModifierKey,
  modifierLabel,
  resolveJump,
  shortcutSections,
  LEADER_KEY,
  MOD,
  type ShortcutFlags,
} from './shortcuts'

/** Everything on — the widest registry a user can be shown. */
const ALL: ShortcutFlags = {
  canViewOrganization: true,
  showKnowledge: true,
  canAccessArchiv: true,
  canCollaborate: true,
  // Separate from `canCollaborate` since ADR-0042: the inbox carries operational
  // alerts as well as collaboration events, so it is reachable on its own gate.
  canAccessInbox: true,
}

/** The floor — a plain member with no optional feature enabled. */
const MINIMAL: ShortcutFlags = { canViewOrganization: false }

describe('jumpTargets', () => {
  test('every leader key is unique under every flag combination', () => {
    // Every combination of the capability flags (derived from `ALL`, so adding a
    // flag widens the sweep automatically); a collision under any one of them
    // would silently shadow a destination.
    const flagKeys = Object.keys(ALL) as (keyof ShortcutFlags)[]
    for (let mask = 0; mask < 1 << flagKeys.length; mask++) {
      const flags: ShortcutFlags = {}
      flagKeys.forEach((key, index) => {
        flags[key] = Boolean(mask & (1 << index))
      })
      const keys = jumpTargets(flags).map((target) => target.key)
      expect(new Set(keys).size, `duplicate under ${JSON.stringify(flags)}`).toBe(keys.length)
    }
  })

  test('leader keys are single lowercase letters, and never the leader itself', () => {
    for (const target of jumpTargets(ALL)) {
      expect(target.key).toMatch(/^[a-z]$/)
      expect(target.key).not.toBe(LEADER_KEY)
    }
  })

  test('flag-gated destinations appear only with their flag', () => {
    const minimal = jumpTargets(MINIMAL).map((target) => target.key)
    expect(minimal).toContain('p') // the projects list is always reachable
    expect(minimal).not.toContain('o') // organization
    expect(minimal).not.toContain('a') // archiv
    expect(minimal).not.toContain('i') // inbox
    expect(minimal).not.toContain('k') // knowledge

    const all = jumpTargets(ALL).map((target) => target.key)
    for (const key of ['o', 'a', 'i', 'k']) expect(all).toContain(key)
  })

  test('the inbox jump follows canAccessInbox, not canCollaborate (ADR-0042)', () => {
    // The decoupling this flag exists for: a tenant WITHOUT collaboration still
    // reaches the inbox, because that is where its operational alerts land. If
    // `g i` were still gated on collaboration, the storage warning would be
    // unreachable by keyboard for exactly the deployments that need it.
    const withoutCollaboration = jumpTargets({ canAccessInbox: true, canCollaborate: false })
    expect(withoutCollaboration.map((target) => target.key)).toContain('i')
    expect(resolveJump('i', { canAccessInbox: true, canCollaborate: false }, null)).toBe('/app/inbox')

    // …and collaboration on its own no longer opens it, so the two flags are
    // genuinely independent rather than one aliasing the other.
    expect(jumpTargets({ canCollaborate: true }).map((target) => target.key)).not.toContain('i')
    expect(resolveJump('i', { canCollaborate: true }, null)).toBeNull()
  })

  test('every rail section a user can see has a jump', () => {
    // The drift this whole module exists to prevent: a section reachable by
    // mouse but not by keyboard.
    const jumps = new Set(jumpTargets(ALL).map((target) => target.key))
    for (const section of railSections(ALL)) {
      expect(section.shortcutKey, `rail section "${section.key}" has no jump key`).toBeTruthy()
      expect(jumps).toContain(section.shortcutKey)
    }
  })

  test('every jump is reachable in the palette too, or is the palette itself', () => {
    // The inbox is the one rail-only destination (its copy lives in the
    // collaboration dictionary); everything else should be in both surfaces.
    const palette = new Set(paletteSections(ALL).map((section) => section.shortcutKey))
    const missing = jumpTargets(ALL)
      .map((target) => target.key)
      .filter((key) => !palette.has(key) && !['p', 'o'].includes(key))
    expect(
      missing,
      'jump keys reachable by keyboard but not from the ⌘K palette — wire the section into the palette, or add its key here with a reason',
    ).toEqual(['i'])
  })
})

describe('resolveJump', () => {
  test('project sections resolve against the active project', () => {
    expect(resolveJump('f', ALL, 'p1')).toBe('/app/projects/p1/files')
    expect(resolveJump('c', ALL, 'p1')).toBe('/app/projects/p1/chat')
    expect(resolveJump('s', ALL, 'p1')).toBe('/app/projects/p1/settings')
  })

  test('project sections resolve to null without a project', () => {
    expect(resolveJump('f', ALL, null)).toBeNull()
    expect(resolveJump('c', ALL, null)).toBeNull()
  })

  test('cross-project doorways resolve from anywhere', () => {
    expect(resolveJump('p', ALL, null)).toBe('/app/projects')
    expect(resolveJump('o', ALL, null)).toBe('/app/organization')
    expect(resolveJump('a', ALL, null)).toBe('/app/archiv')
    expect(resolveJump('i', ALL, null)).toBe('/app/inbox')
  })

  test('unbound and gated-off keys resolve to null', () => {
    expect(resolveJump('z', ALL, 'p1')).toBeNull()
    expect(resolveJump('a', MINIMAL, 'p1')).toBeNull()
  })

  test('the second key is matched case-insensitively', () => {
    expect(resolveJump('F', ALL, 'p1')).toBe('/app/projects/p1/files')
  })
})

describe('shortcutSections', () => {
  test('groups are ordered general → navigation → chat', () => {
    expect(shortcutSections(ALL).map((section) => section.id)).toEqual([
      'general',
      'navigation',
      'chat',
    ])
  })

  test('the navigation group mirrors the jump targets exactly', () => {
    const navigation = shortcutSections(ALL).find((section) => section.id === 'navigation')
    expect(navigation?.rows.map((row) => row.id)).toEqual(
      jumpTargets(ALL).map((target) => `jump-${target.key}`),
    )
  })

  test('the project-scope note appears because a scoped row earned it', () => {
    const navigation = shortcutSections(ALL).find((section) => section.id === 'navigation')
    expect(navigation?.note).toBe(true)
  })

  test('gated rows drop out with their feature', () => {
    const chatRows = (flags: ShortcutFlags) =>
      shortcutSections(flags)
        .find((section) => section.id === 'chat')
        ?.rows.map((row) => row.id)

    expect(chatRows(ALL)).toContain('mention')
    expect(chatRows(MINIMAL)).not.toContain('mention')
  })

  test('every row carries a label, an icon and at least one keycap', () => {
    for (const section of shortcutSections(ALL)) {
      expect(section.rows.length).toBeGreaterThan(0)
      for (const row of section.rows) {
        expect(row.label.key).toBeTruthy()
        expect(row.icon).toBeTruthy()
        expect(row.keys.some((segment) => segment.kind === 'chord')).toBe(true)
      }
    }
  })

  test('row ids are unique across the whole sheet', () => {
    const ids = shortcutSections(ALL).flatMap((section) => section.rows.map((row) => row.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('the palette row is the one that carries the platform modifier', () => {
    const general = shortcutSections(ALL).find((section) => section.id === 'general')
    const palette = general?.rows.find((row) => row.id === 'palette')
    const caps = palette?.keys.flatMap((segment) => (segment.kind === 'chord' ? segment.caps : []))
    expect(caps).toEqual([MOD, 'K'])
  })
})

describe('isModifierKey', () => {
  test.each(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'NumLock'])(
    '%s is a modifier — it can never complete a leader sequence',
    (key) => {
      expect(isModifierKey(key)).toBe(true)
    },
  )

  test.each(['p', 'f', 'G', 'Escape', 'Enter', 'Tab', '1'])('%s is a real key', (key) => {
    expect(isModifierKey(key)).toBe(false)
  })
})

describe('modifierLabel', () => {
  test.each(['MacIntel', 'iPhone', 'iPad', 'macOS'])('%s reads as ⌘', (platform) => {
    expect(modifierLabel(platform)).toBe('⌘')
  })

  test.each(['Win32', 'Windows', 'Linux x86_64', '', undefined, null])(
    '%s reads as Ctrl',
    (platform) => {
      expect(modifierLabel(platform)).toBe('Ctrl')
    },
  )
})
