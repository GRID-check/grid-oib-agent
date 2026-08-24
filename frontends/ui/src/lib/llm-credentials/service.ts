/**
 * BYOK LLM credential service (ADR-0022).
 *
 * Owns the credential lifecycle: live verification against the provider,
 * secret storage (WorkOS Vault / local AES-GCM), atomic activation,
 * rotation, revocation, and the just-in-time resolution the Python backend
 * pulls through `/api/internal/llm-credential`. Every lifecycle transition
 * emits a WorkOS audit event. Plaintext keys exist only inside a request:
 * they are never cached, never logged, never returned to browsers.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { BadRequestError, ConflictError, NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getOrgSettings, updateOrgSettings } from '@/lib/organizations/service'
import { BYOK_LLM_FLAG, isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import type { OrgLlmCredential } from '@/lib/db/schema'
import {
  assertSafeBaseUrl,
  isKnownProvider,
  resolveBaseUrl,
  type LlmCredentialProvider,
} from './providers'
import {
  getActiveCredential,
  getCredential,
  insertActiveCredential,
  listCredentials,
  markUsed,
  markVerified,
  revokeCredential,
} from './repository'
import { activeSecretBackend, deleteSecret, keyFingerprint, keyHint, revealSecret, storeSecret } from './secret-store'

const VERIFY_TIMEOUT_MS = 8_000
const MARK_USED_THROTTLE_MS = 5 * 60 * 1000

/**
 * Which credential serves the org's LLM traffic (ADR-0022):
 *  - 'byok'     — the org's stored key (default while a credential exists).
 *  - 'platform' — the platform key; the stored credential stays in Vault,
 *    unused, so the org can switch back without re-entering the key.
 */
export type LlmProviderMode = 'byok' | 'platform'
const PROVIDER_MODE_SETTING = 'llmProviderMode'

/** Metadata-only view — the ONLY credential shape browsers ever see. */
export interface LlmCredentialView {
  id: string
  provider: string
  label: string
  baseUrl: string | null
  secretBackend: string
  keyHint: string
  keyFingerprint: string
  status: string
  createdBy: string
  createdAt: string
  lastVerifiedAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  rotatedFrom: string | null
}

export function toView(row: OrgLlmCredential): LlmCredentialView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    secretBackend: row.secretBackend,
    keyHint: row.keyHint,
    keyFingerprint: row.keyFingerprint,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    rotatedFrom: row.rotatedFrom,
  }
}

export async function listOrgCredentials(organizationId: string): Promise<LlmCredentialView[]> {
  return (await listCredentials(organizationId)).map(toView)
}

/** The org's chosen traffic mode. Defaults to 'byok' — a connected key is used. */
export async function getLlmProviderMode(organizationId: string): Promise<LlmProviderMode> {
  const { settings } = await getOrgSettings(organizationId)
  return settings[PROVIDER_MODE_SETTING] === 'platform' ? 'platform' : 'byok'
}

/**
 * Flip the org between its own key and the platform service without
 * touching the stored credential. Takes effect on new conversations within
 * the backend's resolution-cache TTL (≤ 60 s).
 */
export async function setLlmProviderMode(
  session: AuthorizedSession,
  mode: LlmProviderMode,
  request: Request,
): Promise<LlmProviderMode> {
  await updateOrgSettings(session.organizationId, { settings: { [PROVIDER_MODE_SETTING]: mode } })
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'llm_credential.mode_changed',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { mode },
    request,
  })
  return mode
}

/**
 * Live check that the key actually works: `GET {baseUrl}/models` with the
 * key as bearer — the one OpenAI-compatible endpoint every preset supports.
 * Returns the number of models visible to the key (0 when unparseable).
 * Throws `UnprocessableError` when the provider rejects the key.
 */
export async function verifyKeyAgainstProvider(baseUrl: string, apiKey: string): Promise<number> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    throw new UnprocessableError('Could not reach the provider endpoint to verify the key')
  }
  if (response.status === 401 || response.status === 403) {
    throw new UnprocessableError('The provider rejected this API key')
  }
  if (!response.ok) {
    throw new UnprocessableError(`Provider verification failed (HTTP ${response.status})`)
  }
  try {
    const body = (await response.json()) as { data?: unknown[] }
    return Array.isArray(body.data) ? body.data.length : 0
  } catch {
    return 0
  }
}

export interface CreateCredentialInput {
  provider: string
  label: string
  baseUrl?: string | null
  apiKey: string
  /** Set when this create supersedes a specific credential (rotation). */
  rotatedFrom?: string | null
}

/**
 * Verify + store + activate a credential, superseding the current active one
 * in the same transaction. Used for both first-time setup and rotation.
 */
export async function createCredential(
  session: AuthorizedSession,
  input: CreateCredentialInput,
  request: Request,
): Promise<LlmCredentialView> {
  if (!isKnownProvider(input.provider)) {
    throw new BadRequestError(`Unknown provider "${input.provider}"`)
  }
  const provider: LlmCredentialProvider = input.provider
  const apiKey = input.apiKey.trim()
  if (apiKey.length < 8 || apiKey.length > 512) {
    throw new BadRequestError('API key length is not plausible')
  }

  let baseUrl: string
  try {
    baseUrl = resolveBaseUrl(provider, input.baseUrl)
    assertSafeBaseUrl(baseUrl)
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : 'Invalid base URL')
  }

  if (input.rotatedFrom) {
    const predecessor = await getCredential(session.organizationId, input.rotatedFrom)
    if (!predecessor) throw new NotFoundError('Credential to rotate does not exist')
    if (predecessor.status !== 'active') {
      throw new ConflictError('Only the active credential can be rotated')
    }
  }

  await verifyKeyAgainstProvider(baseUrl, apiKey)

  const credentialId = randomUUID()
  const secretRef = await storeSecret(session.organizationId, credentialId, apiKey)

  const { inserted, superseded } = await insertActiveCredential(
    {
      id: credentialId,
      organizationId: session.organizationId,
      provider,
      label: input.label.trim(),
      baseUrl: PRESET_URL_PROVIDERS.has(provider) ? null : baseUrl,
      ...secretRef,
      keyFingerprint: keyFingerprint(apiKey),
      keyHint: keyHint(apiKey),
      rotatedFrom: input.rotatedFrom ?? null,
      createdBy: session.userId,
      lastVerifiedAt: new Date(),
    },
    session.userId,
  )
  if (superseded) {
    await deleteSecret(superseded)
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: input.rotatedFrom ? 'llm_credential.rotated' : 'llm_credential.created',
    targetType: 'llm_credential',
    targetId: inserted.id,
    metadata: {
      provider,
      secretBackend: secretRef.secretBackend,
      keyFingerprint: inserted.keyFingerprint,
      supersededCredentialId: superseded?.id,
      rotatedFrom: input.rotatedFrom ?? undefined,
    },
    request,
  })

  return toView(inserted)
}

/** Providers whose base URL is fixed — stored as NULL, resolved from the preset. */
const PRESET_URL_PROVIDERS = new Set<LlmCredentialProvider>(['openrouter', 'openai'])

/** Revoke the active credential; traffic falls back to the platform key. */
export async function revokeOrgCredential(
  session: AuthorizedSession,
  credentialId: string,
  request: Request,
): Promise<LlmCredentialView> {
  const row = await getCredential(session.organizationId, credentialId)
  if (!row) throw new NotFoundError('Credential not found')
  if (row.status !== 'active') throw new ConflictError('Credential is already revoked')

  const revoked = await revokeCredential(session.organizationId, credentialId, session.userId)
  if (!revoked) throw new ConflictError('Credential was revoked concurrently')
  await deleteSecret(row)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'llm_credential.revoked',
    targetType: 'llm_credential',
    targetId: credentialId,
    metadata: { provider: row.provider, keyFingerprint: row.keyFingerprint },
    request,
  })

  return toView(revoked)
}

/** Re-verify the active credential against its provider on demand. */
export async function verifyOrgCredential(
  session: AuthorizedSession,
  credentialId: string,
  request: Request,
): Promise<{ credential: LlmCredentialView; modelCount: number }> {
  const row = await getCredential(session.organizationId, credentialId)
  if (!row) throw new NotFoundError('Credential not found')
  if (row.status !== 'active') throw new ConflictError('Only the active credential can be verified')

  const baseUrl = resolveBaseUrl(row.provider as LlmCredentialProvider, row.baseUrl)
  const apiKey = await revealSecret(row)
  const modelCount = await verifyKeyAgainstProvider(baseUrl, apiKey)
  await markVerified(session.organizationId, credentialId)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'llm_credential.verified',
    targetType: 'llm_credential',
    targetId: credentialId,
    metadata: { provider: row.provider, modelCount },
    request,
  })

  return { credential: toView({ ...row, lastVerifiedAt: new Date() }), modelCount }
}

/** What the Python backend receives — includes the PLAINTEXT key. */
export interface ResolvedCredential {
  id: string
  provider: string
  baseUrl: string
  apiKey: string
  keyFingerprint: string
}

/**
 * Just-in-time resolution for the internal endpoint. Re-checks the org
 * feature flag (when enforcement is on), decrypts, and throttles the
 * `last_used_at` bookkeeping write. Returns null when the org has no BYOK
 * credential — the backend then stays on the platform key.
 */
export async function resolveActiveCredentialForBackend(
  organizationId: string,
): Promise<ResolvedCredential | null> {
  const enforceFlags = (process.env.GRID_ENFORCE_FEATURE_FLAGS ?? '').toLowerCase() === 'true'
  if (enforceFlags && !(await isOrgFeatureEnabled(BYOK_LLM_FLAG, organizationId, false))) {
    return null
  }

  const row = await getActiveCredential(organizationId)
  if (!row) return null

  // The org owner's explicit choice (ADR-0022): a stored key is only USED
  // in 'byok' mode. In 'platform' mode it stays in Vault, idle, and the
  // backend runs on the platform credential — switching back is one toggle.
  if ((await getLlmProviderMode(organizationId)) === 'platform') return null

  let apiKey: string
  try {
    apiKey = await revealSecret(row)
  } catch (error) {
    // Fail open to the platform key — never log key material, only the ref.
    console.error(
      `[LLM Credentials] secret reveal failed for org ${organizationId} credential ${row.id}:`,
      error,
    )
    return null
  }

  const lastUsed = row.lastUsedAt?.getTime() ?? 0
  if (Date.now() - lastUsed > MARK_USED_THROTTLE_MS) {
    markUsed(organizationId, row.id).catch(() => undefined)
  }

  return {
    id: row.id,
    provider: row.provider,
    baseUrl: resolveBaseUrl(row.provider as LlmCredentialProvider, row.baseUrl),
    apiKey,
    keyFingerprint: row.keyFingerprint,
  }
}

export { activeSecretBackend }
