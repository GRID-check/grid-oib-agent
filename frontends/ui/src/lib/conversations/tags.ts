/**
 * Conversation topic tags (Historie chat naming + tag filter).
 *
 * A small, FIXED vocabulary of OIB-Richtlinien topic areas. The backend's
 * title/tag LLM call is constrained to return only these keys, and the
 * Historie filter maps each key to a localised label + source-family colour.
 *
 * Keys are stable, language-neutral slugs — they are what lands in the
 * `conversations.tags` text[] column, so renaming one is a data migration.
 * The seven topic keys track the OIB Richtlinien 1–6 (plus a general bucket):
 *   statik            → OIB 1  Mechanische Festigkeit & Standsicherheit
 *   brandschutz       → OIB 2  Brandschutz
 *   hygiene           → OIB 3  Hygiene, Gesundheit & Umweltschutz
 *   nutzungssicherheit→ OIB 4  Nutzungssicherheit
 *   barrierefreiheit  → OIB 4  Barrierefreiheit
 *   schallschutz      → OIB 5  Schallschutz
 *   energie           → OIB 6  Energieeinsparung & Wärmeschutz
 *   allgemein         → cross-cutting / no single OIB topic
 */

export const CONVERSATION_TAG_KEYS = [
  'brandschutz',
  'schallschutz',
  'barrierefreiheit',
  'energie',
  'statik',
  'hygiene',
  'nutzungssicherheit',
  'allgemein',
] as const

export type ConversationTagKey = (typeof CONVERSATION_TAG_KEYS)[number]

const TAG_KEY_SET: ReadonlySet<string> = new Set(CONVERSATION_TAG_KEYS)

/** Narrow an arbitrary string to a known tag key. */
export function isConversationTagKey(value: string): value is ConversationTagKey {
  return TAG_KEY_SET.has(value)
}

/**
 * Keep only known tag keys, de-duplicated and order-preserving. Used to
 * sanitise whatever the LLM (or a legacy row) hands back before it is stored
 * or rendered — the UI must never try to render an unknown chip.
 */
export function normalizeConversationTags(values: readonly string[]): ConversationTagKey[] {
  const seen = new Set<ConversationTagKey>()
  for (const value of values) {
    const key = value.trim().toLowerCase()
    if (isConversationTagKey(key)) seen.add(key)
  }
  return [...seen]
}
