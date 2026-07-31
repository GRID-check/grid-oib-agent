/**
 * The keyboard-shortcut registry — ONE source of truth for what the app binds
 * and what the cheatsheet documents.
 *
 * The shortcuts feature shipped with the binding logic in `keyboard-shortcuts`
 * and a hand-written list of rows in `shortcuts-cheatsheet`. They drifted the
 * moment the IA grew: the rail gained Files, History, Archiv, Inbox, Workflows
 * and Settings while the only leader jump stayed `g p`, and bindings that live
 * in other components (the composer's Enter / Shift+Enter, the choice prompt's
 * 1–9) were documented — or not — by hand. This module removes the parallel
 * lists:
 *
 *   - {@link resolveJump} is what the global handler executes.
 *   - {@link shortcutSections} is what the cheatsheet renders.
 *   - both derive their navigation half from `project-sections.ts`, the IA's
 *     source of truth, via its `shortcutKey` field.
 *
 * A row therefore cannot exist without a destination, and a destination that
 * declares a `shortcutKey` cannot stay undocumented.
 *
 * **Ownership.** Not every documented shortcut is bound here. `owner` records
 * where a binding actually lives, so the cheatsheet can stay honest about keys
 * the shell does not register itself (the composer's, the choice prompt's, and
 * Radix's Escape). Only `owner: 'shell'` rows are wired by the global handler.
 */

import type { ComponentType } from 'react'
import {
  AtSign,
  Building2,
  Command,
  CornerDownLeft,
  FolderKanban,
  Keyboard,
  ListOrdered,
  WrapText,
  X,
} from 'lucide-react'

import { jumpSections, type ProjectSectionFlags } from './project-sections'

/** Every row carries the icon of the thing it acts on (lucide-react). */
export type ShortcutIcon = ComponentType<{ className?: string }>

/* -------------------------------------------------------------------------- */
/* Keycap model                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A rendered keycap label. `'mod'` is the one magic token: it resolves to `⌘`
 * on Apple platforms and `Ctrl` everywhere else, at render time on the client
 * (the server cannot know the platform).
 */
export type KeyCap = string

/** The `'mod'` token — declared once so callers never spell it by hand. */
export const MOD: KeyCap = 'mod'

/**
 * One piece of a shortcut's visual notation. A shortcut is a short sequence of
 * these, so a chord (`⌘ K`), a leader sequence (`G then P`), an alternative
 * (`Enter or ⌘ Enter`) and a range (`1 – 9`) all render from one array without
 * the cheatsheet special-casing any of them.
 */
export type KeySegment =
  /** Keys pressed together. */
  | { kind: 'chord'; caps: readonly KeyCap[] }
  /** Sequence separator — press the next chord after the previous one. */
  | { kind: 'then' }
  /** Alternative separator — either chord does the same thing. */
  | { kind: 'or' }
  /** Range separator — every key between the two ends is bound. */
  | { kind: 'range' }

const chord = (...caps: KeyCap[]): KeySegment => ({ kind: 'chord', caps })
const THEN: KeySegment = { kind: 'then' }
const OR: KeySegment = { kind: 'or' }
const RANGE: KeySegment = { kind: 'range' }

/**
 * Resolve the `'mod'` keycap for a platform string. Prefers the modern
 * `navigator.userAgentData.platform`; `navigator.platform` (deprecated, but
 * still the only signal in Firefox and Safari) is the fallback. Pure so it can
 * be unit-tested without a browser.
 */
export function modifierLabel(platform: string | undefined | null): '⌘' | 'Ctrl' {
  return /mac|iphone|ipad|ipod/i.test(platform ?? '') ? '⌘' : 'Ctrl'
}

/* -------------------------------------------------------------------------- */
/* Leader-key navigation                                                       */
/* -------------------------------------------------------------------------- */

/** The leader key that arms a navigation sequence. */
export const LEADER_KEY = 'g'

/** How long a pending leader key stays armed, in milliseconds. */
export const LEADER_TIMEOUT_MS = 1500

/**
 * Keys that are modifiers in their own right. `keydown` fires for these on
 * their own — tapping Shift or CapsLock while a leader is armed produces an
 * event whose `key` names the modifier — and none of them can ever complete a
 * sequence. They must therefore be ignored rather than spend the armed leader,
 * or a stray Shift silently costs the user their `g`.
 *
 * `AltGraph` and `OS` are legacy spellings still emitted by older engines.
 */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'OS',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock',
])

/** Whether a `KeyboardEvent.key` names a modifier rather than a real key. */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/**
 * Which capabilities are available to this user. A superset of the section
 * flags, because two jump targets live outside the project IA.
 */
export interface ShortcutFlags extends ProjectSectionFlags {
  /** Whether the organization page is reachable for this user. */
  canViewOrganization?: boolean
}

/** A destination reachable with `g` + one key. */
export interface JumpTarget {
  /** The second key of the sequence (lowercase, one character). */
  key: string
  /**
   * Where the visible label comes from. Navigation rows reuse the label the
   * rail already shows, so the cheatsheet needs no parallel copy.
   */
  label: { namespace: 'nav' | 'collaboration' | 'shortcuts'; key: string }
  /**
   * Resolve the destination for the project the user is currently in. Returns
   * null when the target needs a project and there is none — the sequence then
   * does nothing rather than navigating somewhere surprising.
   */
  href: (projectId: string | null) => string | null
  /** Whether this target only resolves inside a project. */
  scoped: boolean
  /** The destination's own icon — the same one the rail and the palette use. */
  icon: ShortcutIcon
}

/**
 * App-wide jump targets — the two destinations that are not project sections.
 * Kept here rather than in the IA module because neither is a section of a
 * project: they are the shell's own doorways.
 */
function globalJumpTargets(flags: ShortcutFlags): JumpTarget[] {
  const targets: JumpTarget[] = [
    {
      key: 'p',
      label: { namespace: 'nav', key: 'projectSwitcher.allProjects' },
      href: () => '/app/projects',
      scoped: false,
      icon: FolderKanban,
    },
  ]
  if (flags.canViewOrganization) {
    targets.push({
      key: 'o',
      label: { namespace: 'nav', key: 'userMenu.organization' },
      href: () => '/app/organization',
      scoped: false,
      icon: Building2,
    })
  }
  return targets
}

/**
 * Every `g …` target available to this user, in reading order: the app-wide
 * doorways first, then the project sections in rail order.
 */
export function jumpTargets(flags: ShortcutFlags): JumpTarget[] {
  const sections: JumpTarget[] = jumpSections(flags).map((section) => ({
    key: section.shortcutKey as string,
    label: section.label ?? { namespace: 'nav' as const, key: `sections.${section.i18nKey}` },
    href: (projectId: string | null) => {
      if (section.href) return section.href
      if (!projectId) return null
      return section.segment ? `/app/projects/${projectId}/${section.segment}` : `/app/projects/${projectId}`
    },
    // A section with an absolute href (Archiv, Inbox) is a cross-project
    // doorway and works from anywhere; the rest need a project in the URL.
    scoped: !section.href,
    icon: section.icon,
  }))

  return [...globalJumpTargets(flags), ...sections]
}

if (process.env.NODE_ENV !== 'production') {
  // Guard the registry once, at import — not inside `jumpTargets`, which runs
  // on every completed leader sequence: a misconfiguration should surface as a
  // loud module-load failure, never as an exception thrown from a `keydown`
  // handler. Checking the widest set is sufficient, because flags only decide
  // MEMBERSHIP: a key that collides for any user collides here too.
  const keys = jumpTargets({
    canViewOrganization: true,
    showKnowledge: true,
    showWorkflows: true,
    canAccessArchiv: true,
    canCollaborate: true,
  }).map((target) => target.key)
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)
  if (duplicate) {
    throw new Error(`[shortcuts] duplicate leader key "${LEADER_KEY} ${duplicate}"`)
  }
}

/**
 * Resolve `g` + `key` to a destination, or null when the key is unbound or its
 * target needs a project the user is not in.
 */
export function resolveJump(
  key: string,
  flags: ShortcutFlags,
  projectId: string | null,
): string | null {
  const target = jumpTargets(flags).find((candidate) => candidate.key === key.toLowerCase())
  return target ? target.href(projectId) : null
}

/* -------------------------------------------------------------------------- */
/* The cheatsheet model                                                        */
/* -------------------------------------------------------------------------- */

/** Which component actually registers the binding. */
export type ShortcutOwner =
  /** The global handler in `keyboard-shortcuts.tsx`. */
  | 'shell'
  /** The chat composer (`features/layout/components/InputArea`). */
  | 'composer'
  /** The choice prompt's digit picks (`features/chat/.../BranchOptions`). */
  | 'prompt'
  /** Radix — every dialog, popover and drawer closes on Escape. */
  | 'overlay'

export type ShortcutGroupId = 'general' | 'navigation' | 'chat'

export interface ShortcutRow {
  /** Stable id — the React key, and the test handle. */
  id: string
  label: { namespace: 'nav' | 'collaboration' | 'shortcuts'; key: string }
  keys: readonly KeySegment[]
  owner: ShortcutOwner
  /** The icon of the thing the shortcut acts on. */
  icon: ShortcutIcon
  /** Which flag gates the row, if any. `undefined` = always documented. */
  gate?: keyof ShortcutFlags
}

export interface ShortcutSection {
  id: ShortcutGroupId
  /** Key under `shortcuts.cheatsheet.groups`. */
  i18nKey: ShortcutGroupId
  rows: ShortcutRow[]
  /**
   * Whether the group carries the "applies to the project you are in" note.
   * Set when at least one row is project-scoped, so the note appears because
   * the content earned it rather than because it was hard-coded.
   */
  note: boolean
}

const shortcutLabel = (key: string) => ({ namespace: 'shortcuts' as const, key })

/**
 * The cheatsheet's content for this user: three groups, flag-filtered, with the
 * navigation group derived from the live IA.
 */
export function shortcutSections(flags: ShortcutFlags): ShortcutSection[] {
  const targets = jumpTargets(flags)

  const sections: ShortcutSection[] = [
    {
      id: 'general',
      i18nKey: 'general',
      note: false,
      rows: [
        {
          id: 'palette',
          label: shortcutLabel('palette'),
          keys: [chord(MOD, 'K')],
          owner: 'shell',
          icon: Command,
        },
        {
          id: 'cheatsheet',
          label: shortcutLabel('cheatsheet'),
          keys: [chord('?')],
          owner: 'shell',
          icon: Keyboard,
        },
        {
          id: 'dismiss',
          label: shortcutLabel('dismiss'),
          keys: [chord('Esc')],
          owner: 'overlay',
          icon: X,
        },
      ],
    },
    {
      id: 'navigation',
      i18nKey: 'navigation',
      note: targets.some((target) => target.scoped),
      rows: targets.map((target) => ({
        id: `jump-${target.key}`,
        label: target.label,
        keys: [chord(LEADER_KEY.toUpperCase()), THEN, chord(target.key.toUpperCase())],
        owner: 'shell' as const,
        icon: target.icon,
      })),
    },
    {
      id: 'chat',
      i18nKey: 'chat',
      note: false,
      rows: [
        {
          id: 'sendMessage',
          label: shortcutLabel('sendMessage'),
          keys: [chord('Enter'), OR, chord(MOD, 'Enter')],
          owner: 'composer',
          icon: CornerDownLeft,
        },
        {
          id: 'newLine',
          label: shortcutLabel('newLine'),
          keys: [chord('Shift', 'Enter')],
          owner: 'composer',
          icon: WrapText,
        },
        {
          // The mention picker only exists where collaboration is on — the
          // composer checks the same flag before it will even open one.
          id: 'mention',
          label: shortcutLabel('mention'),
          keys: [chord('@')],
          owner: 'composer',
          icon: AtSign,
          gate: 'canCollaborate',
        },
        {
          id: 'chooseOption',
          label: shortcutLabel('chooseOption'),
          keys: [chord('1'), RANGE, chord('9')],
          owner: 'prompt',
          icon: ListOrdered,
        },
      ],
    },
  ]

  // Drop gated-off rows, then any group they emptied — an eyebrow above
  // nothing reads as a bug.
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => !row.gate || Boolean(flags[row.gate])),
    }))
    .filter((section) => section.rows.length > 0)
}
