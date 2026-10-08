/**
 * The organization's upload-screening policy, read and written (ADR-0083), and
 * the server-side repeat of the name gate.
 *
 * The policy lives in `organizations.settings.uploadScreening`. Its one writer
 * is {@link saveUploadScreeningPolicy}: the generic settings save refuses the
 * key (`DEDICATED_ROUTE_SETTINGS`), because that route would store any shape
 * and "screening silently off because a malformed value was saved" is the
 * failure this setting exists to prevent.
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { getCached, invalidateCached } from '@/lib/cache'
import { getOrgSettings, writeDedicatedOrgSetting } from '@/lib/organizations/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { buildContentRules, chatScreeningRules, maskText, type MaskedText } from './content-screen'
import { screenUploadName, type NameMatch, type ScreenedName } from './name-screen'
import {
  SUGGESTED_SCREENING_POLICY,
  resolveUploadScreeningPolicy,
  toChatScreening,
  toIngestScreening,
  type ChatScreening,
  type IngestScreening,
  type UploadScreeningPolicy,
} from './policy'

/** The key in `organizations.settings`. Named once; `DEDICATED_ROUTE_SETTINGS` refers to it. */
export const UPLOAD_SCREENING_SETTING = 'uploadScreening'

const POLICY_CACHE_TTL_MS = 30_000
const policyCacheKey = (organizationId: string): string => `upload-screening:${organizationId}`

/** The policy in force for an organization: its saved one, else Piloti's suggestion. */
export async function getUploadScreeningPolicy(organizationId: string): Promise<UploadScreeningPolicy> {
  return getCached(policyCacheKey(organizationId), POLICY_CACHE_TTL_MS, async () => {
    const { settings } = await getOrgSettings(organizationId)
    return resolveUploadScreeningPolicy(settings[UPLOAD_SCREENING_SETTING])
  })
}

/**
 * The policy for a GATE, which must decide even when the settings row cannot
 * be read. It decides with Piloti's suggestion then: the gates fail closed.
 */
async function policyOrSuggestion(organizationId: string): Promise<UploadScreeningPolicy> {
  try {
    return await getUploadScreeningPolicy(organizationId)
  } catch (error) {
    console.error('[upload-screening] policy unreadable, screening with the suggested list:', error)
    return SUGGESTED_SCREENING_POLICY
  }
}

/** Whether the office has saved a policy of its own, or is still on the suggestion. */
export async function hasSavedUploadScreeningPolicy(organizationId: string): Promise<boolean> {
  const { settings } = await getOrgSettings(organizationId)
  return settings[UPLOAD_SCREENING_SETTING] !== undefined && settings[UPLOAD_SCREENING_SETTING] !== null
}

/**
 * Save the office's policy (already validated by the route's schema) and record
 * who changed it. The audit carries counts, never the lists: what an office
 * calls sensitive is itself something it may not want in a trail other systems
 * stream.
 */
export async function saveUploadScreeningPolicy(
  session: AuthorizedSession,
  policy: UploadScreeningPolicy,
  request: Request
): Promise<UploadScreeningPolicy> {
  await writeDedicatedOrgSetting(session.organizationId, UPLOAD_SCREENING_SETTING, policy)
  await invalidateCached(policyCacheKey(session.organizationId))
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'org.upload_screening.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: {
      enabled: String(policy.enabled),
      nameTerms: policy.nameTerms.length,
      nameExceptions: policy.nameExceptions.length,
      contentTerms: policy.contentTerms.length,
      detectors: policy.detectors.join(','),
    },
    request,
  })
  return policy
}

/**
 * 422 for a file the name gate excludes and its uploader did not release. The
 * matches travel as details, so the client can say which rule and which path
 * segment, in its own words.
 */
export class ScreenedUploadError extends ApiError {
  constructor(readonly matches: NameMatch[]) {
    super(422, 'UPLOAD_SCREENED', 'This file is excluded by the organization’s upload screening', { matches })
  }
}

export interface NameGateResult {
  /** The rules the uploader overrode for this file; empty when nothing matched. */
  overridden: NameMatch[]
}

/**
 * The server's repeat of the name gate, run before a byte is stored.
 *
 * It cannot keep the bytes off this server — they arrived with the request —
 * only off storage and out of the index. The browser's check is the one that
 * keeps them at the office; this one is what makes a client that skipped it
 * harmless.
 *
 * `released` is the uploader's explicit per-file "upload anyway". Honoured, and
 * returned so the caller can audit it once the document has an id.
 */
export async function assertUploadNameAllowed(
  organizationId: string,
  name: ScreenedName,
  released: boolean
): Promise<NameGateResult> {
  const policy = await policyOrSuggestion(organizationId)
  const verdict = screenUploadName(policy, name)
  if (!verdict.blocked) return { overridden: [] }
  if (!released) throw new ScreenedUploadError(verdict.matches)
  return { overridden: verdict.matches }
}

/** The audit event for an override, once the document exists. Best-effort, like every audit emit. */
export async function auditScreeningOverride(
  session: AuthorizedSession,
  input: { documentId: string; projectId: string | null; filename: string; overridden: NameMatch[] },
  request: Request
): Promise<void> {
  if (input.overridden.length === 0) return
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'document.screening_overridden',
    targetType: 'document',
    targetId: input.documentId,
    metadata: {
      projectId: input.projectId ?? '',
      filename: input.filename.slice(0, 200),
      terms: [...new Set(input.overridden.map((match) => match.term))].join(',').slice(0, 200),
    },
    request,
  })
}

/** Parse the multipart flag the upload dialog sends for a file its uploader released. */
export function readScreeningRelease(value: FormDataEntryValue | null): boolean {
  return value === 'name'
}

/**
 * The `screening` field for one `/v1/ingest` call: the office's content rules,
 * or `null` when this document's current bytes were released by a reviewer.
 *
 * Fails CLOSED. A policy that cannot be read screens with Piloti's suggestion,
 * and a row that cannot be read is not released — the worst outcome of either
 * is a file waiting in quarantine, which a reviewer can undo; the opposite
 * error sends a payroll slip to a model, which nobody can.
 */
export async function ingestScreeningFor(
  organizationId: string,
  row: { contentHash: string | null; screeningReleasedHash: string | null } | null
): Promise<IngestScreening | null> {
  const policy = await policyOrSuggestion(organizationId)
  const released = Boolean(row?.contentHash && row.screeningReleasedHash === row.contentHash)
  return toIngestScreening(policy, { released })
}

/**
 * The chat half of the policy, for the chat socket (`/api/internal/chat-screening`).
 * Fails CLOSED like every gate: unreadable settings answer with Piloti's
 * suggested list, never with "off".
 */
export async function chatScreeningFor(organizationId: string): Promise<ChatScreening> {
  return toChatScreening(await policyOrSuggestion(organizationId))
}

/**
 * A person's chat text as it may be stored and sent on: every content term and
 * detector match replaced by its placeholder. The composer masked it already
 * and asked the person first; this repeat is for a client that did not, so the
 * stored history (which title generation and memory reflection later hand to a
 * model) never holds what the composer would have removed. Masking a masked
 * text changes nothing.
 */
export async function maskChatText(organizationId: string, text: string): Promise<MaskedText> {
  return maskText(text, chatScreeningRules(await policyOrSuggestion(organizationId)))
}

/**
 * Text Piloti wrote, as it may be stored: the office's NUMBER checks only.
 * A content term marks a kind of document („Honorarvereinbarung"); the
 * sensitive data is the numbers. An answer that names a term („Es gibt keine
 * Honorarvereinbarung") keeps it, so the stored answer reads as it did live,
 * while a number in a message a client merely labels `assistant` is still
 * masked. A person's own text goes through `maskChatText`.
 */
export async function maskAnswerText(organizationId: string, text: string): Promise<MaskedText> {
  const policy = await policyOrSuggestion(organizationId)
  return maskText(text, policy.enabled ? buildContentRules([], policy.detectors) : null)
}
