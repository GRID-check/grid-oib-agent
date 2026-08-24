/**
 * Norm-registry service — server-only bridge to the backend's admin norm API.
 *
 * The backend attaches no admin token itself; this BFF service holds
 * GRID_ADMIN_TOKEN and forwards it via `X-Admin-Token` (mirroring
 * `@/lib/knowledge/service`). Backend 409/422/400 statuses are re-thrown as the
 * matching typed {@link ApiError} so route handlers relay them faithfully.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import {
  BadRequestError,
  ConflictError,
  UnprocessableError,
  UpstreamError,
} from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { getPlatformOrganizationId } from '@/lib/authz/platform'
import type { GridSession } from '@/lib/auth/types'
import {
  normRegistryEnvelopeSchema,
  verifyNormResponseSchema,
  type NormRegistryEnvelope,
  type PutNormRegistryBody,
  type VerifyNormRequest,
  type VerifyNormResponse,
} from './schemas'

const NORMS_TIMEOUT_MS = 30_000

/** Admin-token header for the backend's `/v1/admin/norms*` endpoints. */
function adminHeaders(): Record<string, string> {
  const token = process.env.GRID_ADMIN_TOKEN
  return token ? { 'X-Admin-Token': token } : {}
}

/** Best-effort human-readable detail from a non-OK backend body. */
async function readDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return ''
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    for (const key of ['detail', 'error', 'message'] as const) {
      if (typeof json[key] === 'string') return json[key] as string
    }
  } catch {
    // plain-text body — fall through
  }
  return text.slice(0, 500)
}

/** Load the whole curated registry (envelope: concurrency version + file). */
export async function getNormRegistry(): Promise<NormRegistryEnvelope> {
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/norms`, {
      headers: adminHeaders(),
      signal: AbortSignal.timeout(NORMS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError('Norm registry backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (!res.ok) {
    throw new UpstreamError(`Norm registry backend returned ${res.status}`)
  }
  const body = await res.json().catch(() => {
    throw new UpstreamError('Norm registry backend returned malformed JSON')
  })
  const parsed = normRegistryEnvelopeSchema.safeParse(body)
  if (!parsed.success) {
    throw new UpstreamError('Norm registry backend returned an unexpected shape')
  }
  return parsed.data
}

/**
 * Persist the whole registry under the held concurrency `version`. Re-throws
 * backend 409/422/400 as typed errors; records an audit event on success
 * (targeting the platform org, never throwing on audit failure).
 */
export async function putNormRegistry(
  session: GridSession | null,
  body: PutNormRegistryBody,
  request?: Request,
): Promise<{ version: number }> {
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/norms`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...adminHeaders() },
      body: JSON.stringify({ version: body.version, registry: body.registry }),
      signal: AbortSignal.timeout(NORMS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError('Norm registry backend unreachable', error instanceof Error ? error.message : undefined)
  }

  if (res.status === 409) {
    throw new ConflictError((await readDetail(res)) || 'Registry wurde parallel geändert')
  }
  if (res.status === 422) {
    throw new UnprocessableError((await readDetail(res)) || 'Registry-Validierung fehlgeschlagen')
  }
  if (res.status === 400) {
    throw new BadRequestError((await readDetail(res)) || 'Ungültige Registry')
  }
  if (!res.ok) {
    throw new UpstreamError(`Norm registry backend returned ${res.status}`)
  }

  const parsed = (await res.json().catch(() => ({}))) as { version?: unknown }
  const nextVersion = typeof parsed.version === 'number' ? parsed.version : body.version + 1

  const organizationId = await getPlatformOrganizationId()
  if (organizationId && session) {
    await recordAuditEvent({
      organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'platform.norm_registry.updated',
      targetType: 'norm_registry',
      targetId: organizationId,
      metadata: { entries: body.registry.entries.length, version: nextVersion },
      request,
    })
  }

  return { version: nextVersion }
}

/** Verify a pointer against RIS. Returns candidates for the admin to pick from. */
export async function verifyNormPointer(payload: VerifyNormRequest): Promise<VerifyNormResponse> {
  let res: Response
  try {
    res = await fetch(`${getBackendUrl()}/v1/admin/norms/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(NORMS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new UpstreamError('RIS verification backend unreachable', error instanceof Error ? error.message : undefined)
  }
  if (res.status === 400 || res.status === 422) {
    throw new BadRequestError((await readDetail(res)) || 'Ungültige Verifizierungsanfrage')
  }
  if (!res.ok) {
    // 502 (RIS unreachable) and any other non-OK collapse to an upstream error.
    throw new UpstreamError(`RIS verification backend returned ${res.status}`)
  }
  const body = await res.json().catch(() => {
    throw new UpstreamError('RIS verification backend returned malformed JSON')
  })
  const parsed = verifyNormResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new UpstreamError('RIS verification backend returned an unexpected shape')
  }
  return parsed.data
}
