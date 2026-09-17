/**
 * The lessons holdout — the only honest answer to "do the lessons help?"
 *
 * A lesson register is a bandage, and a bandage that is never measured is
 * indistinguishable from a superstition. The counters beside each lesson
 * (`helpful_votes` / `harmful_votes`) count votes cast while it was active,
 * which is a temporal CORRELATION: with an always-injected digest every active
 * lesson is "exposed" to every vote, so those numbers cannot separate "this
 * lesson helped" from "answers were good that week".
 *
 * This is the separation. A deterministic slice of conversations receives NO
 * lessons at all, and every vote records which side it fell on, so the two
 * down-vote rates are directly comparable. Both tiers decide with the SAME
 * pure function over the SAME key, so nothing has to be plumbed between them:
 * the Python agent asks before injecting, the BFF asks when stamping a vote,
 * and they cannot disagree.
 *
 * **Default 0 — off.** A product does not degrade a slice of its answers by
 * default; an operator turns measurement on deliberately, in
 * Platform → Retrieval, and turns it off again once the question is answered.
 *
 * **Keyed on the conversation, not the turn**, so a thread is consistently in
 * one arm: a user must not get a lesson-shaped answer and a lesson-free one to
 * the same follow-up. That also means the unit of the experiment is the
 * conversation, which is what any later significance calculation must use.
 *
 * Honest limitation, stated because it decides how to read the result: at low
 * traffic this is under-powered. Interleaving is far more sensitive but does
 * not apply to a prompt block that is either present or absent, so a holdout
 * is the applicable design — and a small difference will need a long window
 * before it means anything.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { getPlatformRetrievalSettings } from '@/lib/retrieval-settings/service'

/** The catalog key carrying the holdout percentage (0 = off). */
export const LESSONS_HOLDOUT_SETTING_KEY = 'lessons.holdout_pct'

/**
 * Whether `conversationId` falls in the holdout slice at `holdoutPct`.
 *
 * Pure and stable: sha256 of the conversation id, first 4 bytes, modulo 100.
 * A hash rather than a counter so both tiers reach the same verdict with no
 * shared state, and so the slice does not move when rows are added.
 */
export function isInHoldoutSlice(conversationId: string, holdoutPct: number): boolean {
  if (holdoutPct <= 0 || !conversationId) return false
  if (holdoutPct >= 100) return true
  const digest = createHash('sha256').update(conversationId).digest()
  return digest.readUInt32BE(0) % 100 < holdoutPct
}

/**
 * The arm this conversation is in, or null when the experiment is off.
 *
 * Null is a third state on purpose: a vote cast while the holdout was off
 * belongs to no arm and must be excluded from the comparison rather than
 * silently counted as "treated", which would bias the treated arm with every
 * vote ever cast before measurement started.
 *
 * Fails open to null — an unreadable setting must never change what a user
 * sees, and a missing arm label is a missing data point, not an outage.
 */
export async function resolveLessonsHoldout(
  conversationId: string | null | undefined
): Promise<boolean | null> {
  if (!conversationId) return null
  try {
    const settings = await getPlatformRetrievalSettings()
    const pct = settings[LESSONS_HOLDOUT_SETTING_KEY]
    if (!pct || pct <= 0) return null
    return isInHoldoutSlice(conversationId, pct)
  } catch {
    return null
  }
}
