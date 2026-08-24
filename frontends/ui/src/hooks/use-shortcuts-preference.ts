'use client'

/**
 * Per-user keyboard-shortcuts preference (the inner gate of the shortcuts
 * feature — the outer gate is the `keyboard-shortcuts` WorkOS feature flag).
 *
 * The app has no generic user-preferences backend surface for this, so the
 * choice lives in localStorage, default ON. SSR-safe: the server snapshot is
 * the default, and reads only touch `window` on the client. All hook
 * instances stay in sync via a custom event (same tab) and the `storage`
 * event (other tabs).
 */

import { useCallback, useSyncExternalStore } from 'react'

export const SHORTCUTS_PREFERENCE_KEY = 'grid.keyboard-shortcuts.enabled'

/** Same-tab change notification (the `storage` event only fires cross-tab). */
const CHANGE_EVENT = 'grid:keyboard-shortcuts-preference'

function readEnabled(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(SHORTCUTS_PREFERENCE_KEY) !== 'false'
  } catch {
    // Storage unavailable (privacy mode) — fall back to the default.
    return true
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

export interface ShortcutsPreference {
  /** Whether keyboard shortcuts are enabled for this user (default true). */
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export function useShortcutsPreference(): ShortcutsPreference {
  const enabled = useSyncExternalStore(subscribe, readEnabled, () => true)

  const setEnabled = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(SHORTCUTS_PREFERENCE_KEY, String(next))
    } catch {
      // Storage unavailable — fail soft; the default (ON) keeps applying.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])

  return { enabled, setEnabled }
}
