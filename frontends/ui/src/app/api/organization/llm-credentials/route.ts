/**
 * Org BYOK LLM credentials (ADR-0022).
 *
 * GET  — list credential METADATA (never key material).
 * POST — verify a new key live against the provider, store the secret
 *        (WorkOS Vault / local AES-GCM), and atomically activate it.
 *
 * Double gate like model-config: `org:models:manage` + the `byok-llm`
 * feature flag.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { LLM_CREDENTIAL_PROVIDERS } from '@/lib/llm-credentials/providers'
import {
  activeSecretBackend,
  createCredential,
  getLlmProviderMode,
  listOrgCredentials,
} from '@/lib/llm-credentials/service'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.byokLlm)
    if (gated) return gated
    const [credentials, mode] = await Promise.all([
      listOrgCredentials(session.organizationId),
      getLlmProviderMode(session.organizationId),
    ])
    return {
      credentials,
      mode,
      secretBackend: activeSecretBackend(),
    }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)

const postSchema = z.object({
  provider: z.enum(LLM_CREDENTIAL_PROVIDERS),
  label: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  apiKey: z.string().min(8).max(512),
  rotatedFrom: z.string().uuid().nullable().optional(),
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.byokLlm)
    if (gated) return gated
    const input = await parseJsonBody(request, postSchema)
    return { credential: await createCredential(session, input, request) }
  },
  { status: 201, authz: { permission: ORG_PERMISSIONS.modelsManage } }
)
