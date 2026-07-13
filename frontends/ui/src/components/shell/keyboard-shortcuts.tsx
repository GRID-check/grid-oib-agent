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
 * Shortcut set (deliberately small):
 *   ⌘K / Ctrl+K   open the command palette
 *   ?             open the shortcuts cheatsheet
 *   g then p      go to the projects list (leader-key style)
 *
 * Plain-key shortcuts never fire while the user is typing (input, textarea,
 * select, contenteditable) and never when a modifier is held, so nothing
 * browser-critical is overridden. ⌘K is the single chorded exception — the
 * palette convention — and is intercepted everywhere.
 */

import * as React from 'react'
import { useRouter } from 'next/navigation'

import { useShortcutsPreference } from '@/hooks/use-shortcuts-preference'
import { CommandPalette } from './command-palette'
import { ShortcutsCheatsheet } from './shortcuts-cheatsheet'

/** How long a pending leader key (`g`) stays armed. */
const LEADER_TIMEOUT_MS = 1500

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
}

export function KeyboardShortcuts({ authRequired, canViewOrganization, showKnowledge = false }: KeyboardShortcutsProps) {
  const { enabled } = useShortcutsPreference()
  const router = useRouter()
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [cheatsheetOpen, setCheatsheetOpen] = React.useState(false)
  const leaderArmedAtRef = React.useRef<number | null>(null)

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

      // Leader sequence: `g` arms, then `p` navigates to the projects list.
      const armedAt = leaderArmedAtRef.current
      if (armedAt !== null && Date.now() - armedAt <= LEADER_TIMEOUT_MS) {
        leaderArmedAtRef.current = null
        if (event.key.toLowerCase() === 'p') {
          event.preventDefault()
          router.push('/app/projects')
        }
        return
      }

      if (event.key.toLowerCase() === 'g' && !event.shiftKey) {
        leaderArmedAtRef.current = Date.now()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, router])

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
      />
      <ShortcutsCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
    </>
  )
}
