import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Per-organization BYOK LLM credentials — METADATA ONLY (ADR-0022).
 *
 * The API key itself never lands in this table. It lives in the pluggable
 * secret store (`lib/llm-credentials/secret-store.ts`): WorkOS Vault
 * (envelope-encrypted under the org's key context; `vault_object_id` points
 * at it) or, for anonymous/dev deployments, an AES-256-GCM ciphertext under
 * the local KEK (`encrypted_key`). Exactly one of the two columns is set,
 * matching `secret_backend`.
 *
 * Lifecycle is append-friendly: rotation inserts a new row linked via
 * `rotated_from` and revokes the predecessor; revocation tombstones the row
 * (status `revoked`) and deletes the secret from the store. The partial
 * unique index below enforces at most one ACTIVE credential per org — the
 * one the internal resolution endpoint serves to the backend.
 *
 * `organization_id` is the WorkOS org id (text, never an FK — ADR-0007).
 */

export const orgLlmCredentials = pgTable(
  'org_llm_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** WorkOS organization id (e.g. `org_...`). */
    organizationId: text('organization_id').notNull(),
    /** Provider preset: `openrouter` | `openai` | `azure-openai` | `custom`. */
    provider: text('provider').notNull(),
    /** Admin-facing label (e.g. "Corporate OpenRouter account"). */
    label: text('label').notNull(),
    /** OpenAI-compatible base URL; NULL = the provider preset's default. */
    baseUrl: text('base_url'),
    /** Which secret store holds the key: `workos-vault` | `local-aes-gcm`. */
    secretBackend: text('secret_backend').notNull(),
    /** WorkOS Vault object id (`workos-vault` backend). */
    vaultObjectId: text('vault_object_id'),
    /** AES-256-GCM envelope JSON (`local-aes-gcm` backend). */
    encryptedKey: text('encrypted_key'),
    /** SHA-256 hex prefix of the key — dedupe/rotation forensics, never reversible. */
    keyFingerprint: text('key_fingerprint').notNull(),
    /** Display hint (`…abcd`) so admins can recognize the key without seeing it. */
    keyHint: text('key_hint').notNull(),
    /** `active` | `revoked`. */
    status: text('status').notNull().default('active'),
    /** Previous credential in a rotation chain. */
    rotatedFrom: uuid('rotated_from'),
    /** WorkOS user id of the admin who created this credential. */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last successful live verification against the provider. */
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    /** Last time the backend resolved this credential for traffic (throttled). */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
  },
  (table) => ({
    /** At most one active credential per organization. */
    activePerOrgUnique: uniqueIndex('uniq_org_llm_credentials_active')
      .on(table.organizationId)
      .where(sql`${table.status} = 'active'`),
    orgIdx: index('idx_org_llm_credentials_org').on(table.organizationId, table.createdAt),
  })
)

export type OrgLlmCredential = typeof orgLlmCredentials.$inferSelect
export type NewOrgLlmCredential = typeof orgLlmCredentials.$inferInsert
