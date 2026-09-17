'use client'

/**
 * Which palette the reader is looking at, right now.
 *
 * ## The authority is the class, not the preference
 *
 * `useLayoutStore(s => s.theme)` holds a PREFERENCE, and one of its three
 * values is `system`, which resolves through a media query the store never
 * re-reads. The resolved answer lives in exactly one place — the `.dark` class
 * `app/providers.tsx` toggles on `<html>`, which is also what `tokens.css`
 * keys on. So that class is the snapshot, and everything else here is only a
 * way of being told to look at it again.
 *
 * ## Three subscriptions, because they arrive by three routes
 *
 *   - **The class itself** (`MutationObserver`). The one that always tells the
 *     truth, and the only one that catches a change made out of band — which
 *     includes `visual/capture.mjs`, whose light and dark screenshots come off
 *     ONE page load by toggling this class. That makes the dark screenshot of a
 *     diagram a real test that the redraw lands, rather than a picture of the
 *     light render on a dark page.
 *   - **The media query**, for `system`, where nothing in React changes at all.
 *   - **The store**, for an explicit light/dark choice.
 *
 * The last two look redundant next to the first and are not: the observer is
 * the delivery mechanism, and a delivery mechanism is a thing that can be
 * unavailable. (happy-dom's `MutationObserver` is a stub with no
 * `takeRecords`, which is exactly why this hook's spec drives the store.)
 * Every route funnels into the same snapshot, so none of them can disagree
 * about the answer — only about when it is re-read.
 *
 * `useSyncExternalStore` rather than an effect, for the reason it exists: a
 * theme flip must not be able to render one frame of the previous palette.
 */

import { useSyncExternalStore } from 'react'
import { useLayoutStore } from '@/features/layout/store'
import type { DiagramTheme } from './render-diagram'

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener?.('change', onChange)
  const unsubscribe = useLayoutStore.subscribe(onChange)
  return () => {
    observer.disconnect()
    media?.removeEventListener?.('change', onChange)
    unsubscribe()
  }
}

function getSnapshot(): DiagramTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** The server has no class list, and paper is the theme a document is on. */
function getServerSnapshot(): DiagramTheme {
  return 'light'
}

export function useDiagramTheme(): DiagramTheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
