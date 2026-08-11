'use client'

/**
 * Global keyboard shortcuts — the client half of the shortcuts feature.
 *
 * Mounted once from the /app layout, and only when the `keyboard-shortcuts`
 * WorkOS feature flag allows it (the outer gate). The per-user preference
 * (profile → keyboard shortcuts, default ON) is the inner gate: when the
 * user turns shortcuts off this component registers ZERO listeners and
 * renders nothing, so the whole feature is inert.
 *
 * What it binds:
 *   ⌘K / Ctrl+K   open the command palette
 *   ?             open the shortcuts cheatsheet
 *   g then <key>  jump to a destination — the set comes from the shortcut
 *                 registry (`shortcuts.ts`), which derives it from the same
 *                 IA the rail and the ⌘K palette render, so a new section
 *                 arrives with its hotkey and its cheatsheet row already
 *                 correct. This used to be a single hard-coded `g p`.
 *
 * Plain-key shortcuts never fire while the user is typing (input, textarea,
 * select, contenteditable) and never when a modifier is held, so nothing
 * browser-critical is overridden. ⌘K is the single chorded exception — the
 * palette convention — and is intercepted everywhere.
 */

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'

import { useShortcutsPreference } from '@/hooks/use-shortcuts-preference'
import { CommandPalette, projectIdFromPathname } from './command-palette'
import { ShortcutsCheatsheet } from './shortcuts-cheatsheet'
import {
  isModifierKey,
  LEADER_KEY,
  LEADER_TIMEOUT_MS,
  resolveJump,
  type ShortcutFlags,
} from './shortcuts'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export interface KeyboardShortcutsProps {
  /** Whether sign-out is meaningful (WorkOS auth configured). */
  authRequired: boolean
  /** Whether the organization page is reachable for this user. */
  canViewOrganization: boolean
  /** Whether the project knowledge page is enabled (feature-flagged, default off). */
  showKnowledge?: boolean
  /** Whether the IFC/BIM model page is enabled (`ifc-models`, ADR-0045). */
  showModels?: boolean
  /**
   * Whether the Agent Skills page is enabled (feature-flagged, default off —
   * ADR-0046).
   */
  showSkills?: boolean
  /** Whether the org-wide Archiv is reachable (`organization-archiv`, ADR-0024). */
  canAccessArchiv?: boolean
  /** Whether the collaboration surfaces are reachable (`collaboration`, ADR-0032…0035). */
  canCollaborate?: boolean
  /** Inbox reachability — gates the `g i` jump (ADR-0042, see NavFlags). */
  canAccessInbox?: boolean
}

export function KeyboardShortcuts({
  authRequired,
  canViewOrganization,
  showKnowledge = false,
  showModels = false,
  showSkills = false,
  canAccessArchiv = false,
  canCollaborate = false,
  canAccessInbox = false,
}: KeyboardShortcutsProps) {
  const { enabled } = useShortcutsPreference()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [cheatsheetOpen, setCheatsheetOpen] = React.useState(false)
  const leaderArmedAtRef = React.useRef<number | null>(null)

  const flags: ShortcutFlags = React.useMemo(
    () => ({
      canViewOrganization,
      showKnowledge,
      showSkills,
      showModels,
      canAccessArchiv,
      canCollaborate,
      canAccessInbox,
    }),
    [
      canViewOrganization,
      showKnowledge,
      showSkills,
      showModels,
      canAccessArchiv,
      canCollaborate,
      canAccessInbox,
    ],
  )

  // The handler reads the live path (a jump to "Files" means the project the
  // user is looking at), so keep it in a ref rather than re-registering the
  // listener on every navigation.
  const projectIdRef = React.useRef<string | null>(null)
  projectIdRef.current = projectIdFromPathname(pathname)

  React.useEffect(() => {
    // Inner gate: shortcuts off → zero listeners.
    if (!enabled) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return

      // ⌘K / Ctrl+K — the palette chord works everywhere, including inputs.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault()
        leaderArmedAtRef.current = null
        setCheatsheetOpen(false)
        setPaletteOpen((prev) => !prev)
        return
      }

      // Plain-key shortcuts: never with a modifier, never while typing.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableTarget(event.target)) return

      if (event.key === '?') {
        event.preventDefault()
        leaderArmedAtRef.current = null
        setCheatsheetOpen(true)
        return
      }

      // Leader sequence: `g` arms, the next key picks the destination. An
      // unbound second key (or a target that needs a project the user is not
      // in) simply disarms — never a navigation the user did not ask for.
      const armedAt = leaderArmedAtRef.current
      if (armedAt !== null && Date.now() - armedAt <= LEADER_TIMEOUT_MS) {
        // A lone modifier keydown (Shift, CapsLock, …) cannot complete a
        // sequence, so it must not spend the leader: reaching for a capital
        // letter would otherwise cost the user their `g`.
        if (isModifierKey(event.key)) return
        leaderArmedAtRef.current = null
        const href = resolveJump(event.key, flags, projectIdRef.current)
        if (href) {
          event.preventDefault()
          router.push(href)
        }
        return
      }

      if (event.key.toLowerCase() === LEADER_KEY && !event.shiftKey) {
        leaderArmedAtRef.current = Date.now()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, router, flags])

  // Inner gate: nothing rendered either — the feature is fully inert.
  if (!enabled) return null

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        authRequired={authRequired}
        canViewOrganization={canViewOrganization}
        showKnowledge={showKnowledge}
        showModels={showModels}
        showSkills={showSkills}
        canAccessArchiv={canAccessArchiv}
      />
      <ShortcutsCheatsheet
        open={cheatsheetOpen}
        onOpenChange={setCheatsheetOpen}
        canViewOrganization={canViewOrganization}
        showKnowledge={showKnowledge}
        showModels={showModels}
        showSkills={showSkills}
        canAccessArchiv={canAccessArchiv}
        canCollaborate={canCollaborate}
        canAccessInbox={canAccessInbox}
      />
    </>
  )
}
