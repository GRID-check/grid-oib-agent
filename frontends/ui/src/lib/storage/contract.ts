/**
 * The storage-quota wire contract: the shape the API accepts, and the one
 * function that turns what an operator typed into it.
 *
 * ## Why this is a module and not two literals
 *
 * The constraint used to be written twice — once as the route's zod schema
 * (`positive integer of bytes`) and once as the editor input's `min="0"` /
 * `step="1"` — and the two did not agree. `step="1"` rejected the decimal the
 * editor itself prefilled, `min="0"` accepted a zero the API answered 422, and
 * neither guarded the case that actually mattered: `Number('12x')` is `NaN`,
 * `JSON.stringify` writes `NaN` as `null`, and `null` is how this API spells
 * UNLIMITED. A single mistyped character therefore removed a tenant's quota and
 * the UI reported success.
 *
 * So the parse lives here, once, and the editor has no numeric logic of its own.
 * `min`/`step` are deliberately NOT re-stated as HTML constraints: HTML's `min`
 * is inclusive and cannot express "greater than zero", so any value chosen for
 * it is either wrong or a second, different rule — which is the thing that broke.
 * The input carries `step="any"` so it stops rejecting its own prefill, and
 * {@link parseQuotaDraft} is the only authority on what is acceptable.
 *
 * The same defect exists locally in `project-intake-wizard.tsx`, whose comment
 * notes that an entered `1e999` serializes to `null` and "would corrupt the
 * fact". That guard was written for that one form; this module is where the
 * lesson goes so the next numeric field inherits it.
 *
 * Client-safe by construction: no `server-only`, no db, no imports beyond zod —
 * because the whole point is that the browser and the route read the same file.
 */

import { z } from 'zod'

/** Quotas are entered in GB; bytes are the wire unit, never a UI one. */
export const BYTES_PER_GB = 1e9

/**
 * The largest quota this system can carry, in bytes (~9 PB).
 *
 * Not a product limit — a representational one. Quotas travel as JSON numbers
 * and are compared against a `sum(file_size)` that arrives as a bigint string,
 * so past `Number.MAX_SAFE_INTEGER` the comparison stops being exact and
 * `usedBytes + incoming > quotaBytes` starts answering questions about rounding
 * rather than about storage. A limit no one can reach is still a limit; a limit
 * that silently means a different number than it says is not.
 */
export const MAX_QUOTA_BYTES = Number.MAX_SAFE_INTEGER

/**
 * The PUT body for a platform quota write.
 *
 * `null` means unlimited — an explicit decision, not an absent value, which is
 * why it is nullable rather than optional. The chain makes every other
 * degenerate value (0, negative, fractional bytes, `Infinity`, `NaN`, and
 * anything above {@link MAX_QUOTA_BYTES}) a 400 at the boundary, so a 422 from
 * this endpoint has exactly one meaning left: the quota is below what the
 * organization already stores.
 *
 * This schema is also what {@link parseQuotaDraft} judges its own output with,
 * which is what keeps the browser's idea of "acceptable" from drifting from the
 * route's — the drift that this module was created to remove.
 */
export const storageQuotaPutSchema = z.object({
  quotaBytes: z.number().int().positive().max(MAX_QUOTA_BYTES).nullable(),
})

export type StorageQuotaPut = z.infer<typeof storageQuotaPutSchema>

/** Why a typed quota was refused, for the caller to turn into a message. */
export type QuotaDraftRejection = 'notANumber' | 'notPositive' | 'tooLarge'

export type QuotaDraft =
  | { ok: true; quotaBytes: number | null }
  | { ok: false; reason: QuotaDraftRejection }

/**
 * Read an operator's typed quota, in GB, into the bytes the API takes.
 *
 * Empty means unlimited, and that is the one case where a blank field is a
 * decision rather than a mistake — clearing the box is how you lift a limit.
 * Every other value is judged **after** it has been scaled to bytes, and by the
 * schema the route itself uses, for one reason: the number that has to survive
 * `JSON.stringify` is the byte count, not what was typed. Checking the typed
 * value instead is a live defect, not a stylistic preference —
 *
 * - `Number('12x')` → `NaN` → `JSON.stringify` → `null`
 * - `Number('1e999')` → `Infinity` → `JSON.stringify` → `null`
 * - `Number('1e300')` is perfectly finite; `1e300 * 1e9` is `Infinity` → `null`
 *
 * — and `null` is how this API spells UNLIMITED, so each of those removes the
 * tenant's quota while the UI reports success. The third one survived a guard
 * that tested `Number.isFinite` on the input, which is exactly why the guard now
 * sits on the output and is the route's own schema rather than a copy of it.
 *
 * A value small enough to round to zero bytes is refused for the same reason it
 * would be refused server-side: a zero-byte quota is not a quota, it is an
 * outage the operator did not ask for.
 */
export function parseQuotaDraft(raw: string): QuotaDraft {
  const trimmed = raw.trim()
  // Checked before `Number`, which reads both '' and ' ' as 0.
  if (trimmed === '') return { ok: true, quotaBytes: null }

  const gb = Number(trimmed)
  if (Number.isNaN(gb)) return { ok: false, reason: 'notANumber' }

  const quotaBytes = Math.round(gb * BYTES_PER_GB)
  if (storageQuotaPutSchema.safeParse({ quotaBytes }).success) {
    return { ok: true, quotaBytes }
  }

  // Rejected. The reason only selects a message, so it is chosen by which end of
  // the range the operator fell off — the part they can act on. `Infinity` lands
  // here as `tooLarge`, which is both true and the advice they need.
  return { ok: false, reason: quotaBytes > 0 ? 'tooLarge' : 'notPositive' }
}

/**
 * Render a stored quota back into the editor's unit.
 *
 * Here rather than in the component so the round trip is one file: whatever this
 * produces, {@link parseQuotaDraft} must accept.
 */
export function formatQuotaDraft(quotaBytes: number): string {
  return String(quotaBytes / BYTES_PER_GB)
}
