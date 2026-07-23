import type { CSSProperties } from 'react'

/**
 * The provenance signal color family (spec §4, the `--source-*` tokens): law
 * (blue, Baurecht & Richtlinien), project (green, Projektwissen), office (gold,
 * Büroarchiv). One source of truth for the tint so cards, chips and badges never
 * re-derive the same `var(--source-*)` strings inline (they used to, in four
 * places, each with its own stale pre-token fallback chain).
 */
export type SourceSignal = 'law' | 'project' | 'office'

/** Subtle tint (tinted background + readable text) for a provenance chip/pill. */
export function sourceTint(signal: SourceSignal): CSSProperties {
  return {
    backgroundColor: `var(--source-${signal}-tint)`,
    color: `var(--source-${signal}-text)`,
  }
}

/** The full-strength base color for a provenance signal (icons, accents, bars). */
export function sourceBase(signal: SourceSignal): string {
  return `var(--source-${signal})`
}
