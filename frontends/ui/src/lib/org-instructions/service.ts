/**
 * Organization instructions service — the standing instruction block a tenant
 * writes once and every turn carries.
 *
 * ## What this replaces
 *
 * Two mechanisms that both forced an instruction onto a turn and both got the
 * layering wrong:
 *
 *   - `delivery: 'standard'` platform skills — the PLATFORM's instruction
 *     wearing a tenant-shaped switch nobody could reach (migration 0088).
 *   - the composer's `skills` array on the WS envelope — a per-message choice
 *     standing in for a standing preference, re-made or forgotten on every send.
 *
 * A skill is a capability the model may reach for. A skill that is always
 * forced is an instruction pretending to be one. Instructions now live in the
 * two places instructions belong: the platform prompt for what the platform
 * says, and this block for what a tenant says.
 *
 * ## The boundary the copy states
 *
 * Standing preferences on FORM, FOCUS and WORKFLOW. It never overrides Piloti's
 * own rules and it never supplies a normative value — an OIB limit comes from
 * the norm, never from a sentence typed into settings. That is enforced on the
 * backend, where the block is rendered into the prompt; the UI says it so the
 * person writing one knows what the box is for.
 *
 * ## Authorization
 *
 * `org:settings:manage`, the permission ADR-0016's registry already defines for
 * "settings that shape how the organization behaves for everyone in it" — the
 * same gate as the web-search toggle and the default locale, and the same one
 * the route declares. Reading is any member: the block shapes every answer they
 * get, so it is not a secret from them.
 */

import 'server-only'
import { z } from 'zod'
import { getCached, invalidateCached } from '@/lib/cache'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { ORG_INSTRUCTIONS_MAX_CHARS } from './constants'
import {
  deleteOrganizationInstructions,
  findOrganizationInstructions,
  upsertOrganizationInstructions,
} from './repository'

/** The block as a client sees it. `instructions: null` = none written. */
export interface OrgInstructions {
  instructions: string | null
  updatedBy: string | null
  updatedByEmail: string | null
  /** ISO-8601, or null when nothing is stored. */
  updatedAt: string | null
}

const EMPTY: OrgInstructions = {
  instructions: null,
  updatedBy: null,
  updatedByEmail: null,
  updatedAt: null,
}

/**
 * The write boundary.
 *
 * `.max()` and not a silent truncation: an instruction quietly cut at 1500
 * characters is an instruction whose last sentence says something its author
 * never wrote. The number is the backend's cap and the SQL CHECK's bound, from
 * the one module that holds it.
 *
 * Trimmed, and an all-whitespace block reads as CLEAR rather than as a
 * validation error — someone who selects all and deletes has cleared the box,
 * and telling them it is invalid would be pedantry.
 */
export const orgInstructionsSchema = z.object({
  instructions: z
    .string()
    .max(
      ORG_INSTRUCTIONS_MAX_CHARS,
      `Instructions are at most ${ORG_INSTRUCTIONS_MAX_CHARS} characters.`,
    ),
})

export type OrgInstructionsInput = z.infer<typeof orgInstructionsSchema>

const INSTRUCTIONS_CACHE_TTL_MS = 30_000

/**
 * Organization-segmented, as `grid/require-tenant-cache-key` requires and as
 * `getCached` demands in practice: the loader runs only on a miss, so a key
 * without the organization would serve whichever tenant populated it first —
 * and this value goes into a prompt.
 */
const instructionsCacheKey = (organizationId: string): string => `orginstructions:${organizationId}`

/**
 * The turn path's read: the block's TEXT, or null.
 *
 * Cached for 30s and write-invalidated, the same posture as the web-search and
 * ZDR reads it sits beside on the WS upgrade (ADR-0020). Cached as a plain
 * string (or the empty string for "none") rather than as the row: `getCached`
 * round-trips through JSON and casts without validating, so a `Date` in the
 * cached shape type-checks and then hands every cache HIT a string wearing a
 * `Date`'s type.
 *
 * Fails SOFT to null. An instruction block is a preference; a database hiccup
 * while reading one must cost the turn its preferences, never the turn.
 */
export async function resolveOrgInstructions(
  organizationId: string | null | undefined,
): Promise<string | null> {
  if (!organizationId) return null
  try {
    const cached = await getCached(
      instructionsCacheKey(organizationId),
      INSTRUCTIONS_CACHE_TTL_MS,
      async () => (await findOrganizationInstructions(organizationId))?.instructions ?? '',
    )
    return cached ? cached : null
  } catch (error) {
    console.warn('[Org instructions] Failed to resolve; sending none:', error)
    return null
  }
}

/** The settings page's read: the block plus who last wrote it. Uncached — one row, one reader. */
export async function getOrgInstructions(organizationId: string): Promise<OrgInstructions> {
  const row = await findOrganizationInstructions(organizationId)
  if (!row) return EMPTY
  return {
    instructions: row.instructions,
    updatedBy: row.updatedBy,
    updatedByEmail: row.updatedByEmail,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Write or clear the block, then invalidate the turn path's cached copy.
 *
 * Clearing is a DELETE (see the repository): "never written" and "written, then
 * emptied" are one state, so the header is absent in both and the backend has
 * one case to handle rather than two.
 *
 * The audit event is `org.settings.updated` with `fields: instructions` rather
 * than an action of its own. A new action needs a matching WorkOS Audit Log
 * schema provisioned into every environment before it can be emitted at all
 * (`npm run provision:audit-schemas`), and this is the same kind of change the
 * existing action already covers: a tenant-chosen setting that shapes the
 * product for everyone in the organization.
 */
export async function saveOrgInstructions(
  session: AuthorizedSession,
  input: OrgInstructionsInput,
  request: Request,
): Promise<OrgInstructions> {
  const text = input.instructions.trim()

  const result = text
    ? await upsertOrganizationInstructions({
        organizationId: session.organizationId,
        instructions: text,
        updatedBy: session.userId,
        updatedByEmail: session.email,
      })
    : null

  if (!result) {
    await deleteOrganizationInstructions(session.organizationId)
  }

  await invalidateCached(instructionsCacheKey(session.organizationId))

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.settings.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { fields: text ? 'instructions' : 'instructions:cleared' },
    request,
  })

  if (!result) return EMPTY
  return {
    instructions: result.instructions,
    updatedBy: result.updatedBy,
    updatedByEmail: result.updatedByEmail,
    updatedAt: result.updatedAt.toISOString(),
  }
}
