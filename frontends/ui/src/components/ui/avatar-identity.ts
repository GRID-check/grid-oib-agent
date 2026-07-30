/**
 * Deterministic identity colour and initials for a person's avatar.
 *
 * Why this exists: a participant strip is only readable at a glance if the same
 * colleague is always the same colour. Colouring by *position in the list* (the
 * naive approach) makes the strip change under the reader every time somebody is
 * invited, which destroys exactly the recognition the strip is for. So the colour
 * is derived from the **user id** — stable across sessions, surfaces, and reorders
 * — and this module is the single place that derivation happens, because the
 * mention picker needs the same answer as the roster.
 *
 * It lives beside `avatar.tsx` / `avatar-stack.tsx` rather than inside a feature
 * because it is an *avatar* concern, not a collaboration one: five surfaces
 * across three features (participant strip, awaiting banner, access overview,
 * mention picker, message bubbles) draw the same discs, and a second copy of this
 * derivation would make one colleague two colours.
 *
 * How it stays inside the design language, which reserves chroma for the
 * provenance signal system (`docs/design/grid-design-language.md` §2):
 *
 *   1. **Identity is not signal.** These tints never carry meaning — they are a
 *      recognition aid on a disc that also always shows initials or a photo, so a
 *      colour-blind reader loses nothing. No provenance colour is used or implied.
 *   2. **The hue is the only generated part.** Lightness and chroma are two
 *      constants, and the actual colour is a `color-mix()` against the *theme's*
 *      own `--card` / `--foreground` tokens. That is what keeps dark mode free:
 *      those tokens flip, so the tint deepens and the ink lightens with no second
 *      palette and no `dark:` variant to forget. It also means the discs can never
 *      drift away from the surrounding surface.
 *   3. **Muted by construction.** A 16% tint of a mid-chroma hue on paper is a
 *      whisper, not a highlight, and the ink mix keeps text contrast well above AA
 *      in both themes (the ink borrows 45% from `--foreground`, which is dark on
 *      paper and near-white on charcoal — so both directions gain contrast).
 *
 * Pure and dependency-free on purpose: it is unit-testable, callable from a
 * server component, and cheap enough to call during render.
 */

import type { CSSProperties } from 'react'

/**
 * The hue ring. Ten hues, evenly spread and deliberately *not* aligned to the
 * provenance signals' exact hues, so an identity tint never reads as a law-blue
 * or project-green badge. Ten is enough that a collision inside one conversation
 * is unlikely, and small enough that the set still looks like a chosen palette
 * rather than arbitrary noise.
 */
export const AVATAR_HUES = [22, 56, 92, 138, 176, 214, 250, 288, 320, 352] as const

/** Lightness/chroma of the identity hue before it is mixed into the theme. */
const BASE_LIGHTNESS = 0.62
const BASE_CHROMA = 0.13

/** How much of the identity hue lands in the disc surface (percent). */
const TINT_STRENGTH = 16
/** How much of it lands in the initials' ink; the rest comes from `--foreground`. */
const INK_STRENGTH = 55

/**
 * FNV-1a (32-bit). Chosen over `reduce`-ing char codes because that trivial
 * variant maps anagrams and many short ids onto the same bucket; FNV spreads the
 * UUID-shaped ids we actually get. `Math.imul` keeps the multiply in 32 bits.
 */
function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Index into {@link AVATAR_HUES} for a user id. An empty or whitespace-only id
 * has nothing to derive from and deterministically takes the first slot rather
 * than throwing — an avatar must always render.
 */
export function avatarPaletteIndex(userId: string): number {
  const key = userId.trim()
  if (!key) return 0
  return hash32(key) % AVATAR_HUES.length
}

/** The hue (degrees) this user is always drawn in. */
export function avatarHue(userId: string): number {
  return AVATAR_HUES[avatarPaletteIndex(userId)]
}

/**
 * Inline style for a person's avatar disc: a tinted surface and matching ink,
 * both mixed against theme tokens so the pair is correct in light and dark.
 *
 * Returned as a style object rather than a class name because the hue is
 * computed at runtime and Tailwind can only emit classes it saw at build time.
 */
export function avatarColorStyle(userId: string): CSSProperties {
  const base = `oklch(${BASE_LIGHTNESS} ${BASE_CHROMA} ${avatarHue(userId)})`
  return {
    backgroundColor: `color-mix(in oklch, ${base} ${TINT_STRENGTH}%, var(--card))`,
    color: `color-mix(in oklch, ${base} ${INK_STRENGTH}%, var(--foreground))`,
  }
}

/**
 * Up-to-two-letter initials for the avatar fallback, from the parts of a display
 * name. Falls back to `?` so a nameless directory row still renders a disc.
 */
export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts
    .slice(0, 2)
    .map((part) => [...part][0]?.toLocaleUpperCase() ?? '')
    .join('')
  return letters || '?'
}
