/**
 * Pluggable secret store for BYOK LLM keys (ADR-0022).
 *
 * Two backends, chosen per deployment and recorded per credential row so a
 * deployment can migrate without re-encrypting in one shot:
 *
 *  - `workos-vault` — the production path. Keys are envelope-encrypted by
 *    WorkOS Vault under the ORGANIZATION's key context
 *    (`context: { organizationId }`), giving cryptographic tenant isolation,
 *    and enterprise tenants can upgrade to customer-managed KEKs (WorkOS
 *    Vault BYOK) with zero Grid changes. We store only the Vault object id.
 *
 *  - `local-aes-gcm` — anonymous/dev fallback. AES-256-GCM under the 32-byte
 *    base64 `GRID_BYOK_LOCAL_KEK`, with `orgId:credentialId` as AAD so a
 *    ciphertext can't be replayed across tenants or rows.
 *
 * NOTHING here may touch `@/lib/cache` — the shared cache can be
 * Redis-backed (ADR-0020) and plaintext keys must never leave process memory
 * except toward WorkOS Vault or the caller.
 */

import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { getWorkOS } from '@/lib/workos/client'

export type SecretBackend = 'workos-vault' | 'local-aes-gcm'

export interface StoredSecretRef {
  secretBackend: SecretBackend
  vaultObjectId: string | null
  encryptedKey: string | null
}

/** The columns revealSecret/deleteSecret need — DB rows type these as plain strings. */
export interface SecretRowLike {
  id: string
  organizationId: string
  secretBackend: string
  vaultObjectId: string | null
  encryptedKey: string | null
}

/** Which backend new credentials use in this deployment. */
export function activeSecretBackend(): SecretBackend {
  const configured = (process.env.GRID_BYOK_SECRET_BACKEND ?? '').toLowerCase()
  if (configured === 'vault' || configured === 'workos-vault') return 'workos-vault'
  if (configured === 'local' || configured === 'local-aes-gcm') return 'local-aes-gcm'
  return process.env.WORKOS_API_KEY ? 'workos-vault' : 'local-aes-gcm'
}

/**
 * Display/audit-only fingerprint for an API key: the first 16 hex chars of
 * SHA-256.
 *
 * This is NOT a password verifier and NOT a shortening of the key. The
 * persisted secret is only ever the AES-256-GCM envelope or the WorkOS Vault
 * object id (see storeSecret); nothing authenticates a candidate key against
 * this value — it is shown next to the key hint (`…abcd · deadbeefdeadbeef`)
 * so admins can eyeball which key a row holds, and it rides in audit
 * metadata to correlate events back to a row. Recovery is infeasible for the
 * same reason an SSH host fingerprint is: the key carries ~200 bits of
 * entropy and the stored value keeps only 64, so exhaustively matching the
 * fingerprint yields no more information about the key itself. Invariant for
 * callers: only provider-issued, high-entropy credentials may pass through
 * here — the fast hash is safe precisely because its input is unguessable; a
 * user-chosen low-entropy value would make this stored fingerprint
 * brute-forceable and must never reach this function. (CodeQL's
 * js/insufficient-password-hash flags the raw SHA-256; that alert does not
 * apply here — there is no hash-to-verify path, a KDF would slow nothing
 * down, and an HMAC could not be computed on the WorkOS path where no KEK
 * exists. Callers wanting to RECOVER a key must use revealSecret(), not
 * this.)
 */
export function keyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16)
}

/** Display hint: the last 4 characters, `…abcd`. */
export function keyHint(apiKey: string): string {
  return `…${apiKey.slice(-4)}`
}

// ---------------------------------------------------------------------------
// local-aes-gcm backend
// ---------------------------------------------------------------------------

interface LocalEnvelope {
  v: 1
  alg: 'aes-256-gcm'
  iv: string
  ct: string
  tag: string
}

function localKek(): Buffer {
  const raw = process.env.GRID_BYOK_LOCAL_KEK
  if (!raw) {
    throw new Error(
      'GRID_BYOK_LOCAL_KEK is not set — required for the local-aes-gcm BYOK secret backend (32 bytes, base64)',
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('GRID_BYOK_LOCAL_KEK must decode to exactly 32 bytes (AES-256)')
  }
  return key
}

function aad(organizationId: string, credentialId: string): Buffer {
  return Buffer.from(`${organizationId}:${credentialId}`, 'utf8')
}

export function encryptLocal(organizationId: string, credentialId: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', localKek(), iv)
  cipher.setAAD(aad(organizationId, credentialId))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope: LocalEnvelope = {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
  return JSON.stringify(envelope)
}

export function decryptLocal(organizationId: string, credentialId: string, envelopeJson: string): string {
  const envelope = JSON.parse(envelopeJson) as LocalEnvelope
  if (envelope.v !== 1 || envelope.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported local secret envelope')
  }
  const decipher = createDecipheriv('aes-256-gcm', localKek(), Buffer.from(envelope.iv, 'base64'))
  decipher.setAAD(aad(organizationId, credentialId))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// workos-vault backend
// ---------------------------------------------------------------------------

function vaultObjectName(organizationId: string, credentialId: string): string {
  return `grid-llm-credential-${organizationId}-${credentialId}`
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Store a new secret; returns the columns to persist on the credential row.
 * `credentialId` must be generated by the caller BEFORE insert so the AAD /
 * Vault object name are bound to the row identity.
 */
export async function storeSecret(
  organizationId: string,
  credentialId: string,
  apiKey: string,
): Promise<StoredSecretRef> {
  const backend = activeSecretBackend()
  if (backend === 'workos-vault') {
    const object = await getWorkOS().vault.createObject({
      name: vaultObjectName(organizationId, credentialId),
      value: apiKey,
      context: { organizationId },
    })
    return { secretBackend: 'workos-vault', vaultObjectId: object.id, encryptedKey: null }
  }
  return {
    secretBackend: 'local-aes-gcm',
    vaultObjectId: null,
    encryptedKey: encryptLocal(organizationId, credentialId, apiKey),
  }
}

/** Decrypt/fetch the plaintext key for a credential row. Never log the result. */
export async function revealSecret(row: SecretRowLike): Promise<string> {
  if (row.secretBackend === 'workos-vault') {
    if (!row.vaultObjectId) throw new Error('Credential row has no Vault object id')
    const object = await getWorkOS().vault.readObject({ id: row.vaultObjectId })
    const value = (object as { value?: unknown }).value
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Vault object has no readable value')
    }
    return value
  }
  if (row.secretBackend !== 'local-aes-gcm') {
    throw new Error(`Unknown secret backend "${row.secretBackend}"`)
  }
  if (!row.encryptedKey) throw new Error('Credential row has no local ciphertext')
  return decryptLocal(row.organizationId, row.id, row.encryptedKey)
}

/** Best-effort secret deletion on revocation. Never throws. */
export async function deleteSecret(row: SecretRowLike): Promise<void> {
  try {
    if (row.secretBackend === 'workos-vault' && row.vaultObjectId) {
      await getWorkOS().vault.deleteObject({ id: row.vaultObjectId })
    }
    // local-aes-gcm: the row update (encrypted_key = NULL) is the deletion.
  } catch (error) {
    console.warn(`[LLM Credentials] Vault secret deletion failed for credential ${row.id}:`, error)
  }
}
