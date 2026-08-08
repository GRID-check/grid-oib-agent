/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: vi.fn(() => {
    throw new Error('WorkOS must not be touched by local-backend tests')
  }),
}))

import {
  activeSecretBackend,
  decryptLocal,
  encryptLocal,
  keyFingerprint,
  keyHint,
} from './secret-store'

// 32 zero bytes, base64 — a valid AES-256 KEK for tests only.
const TEST_KEK = Buffer.alloc(32, 7).toString('base64')

describe('llm-credentials secret store (local-aes-gcm)', () => {
  beforeEach(() => {
    process.env.GRID_BYOK_LOCAL_KEK = TEST_KEK
    delete process.env.GRID_BYOK_SECRET_BACKEND
    delete process.env.WORKOS_API_KEY
  })
  afterEach(() => {
    delete process.env.GRID_BYOK_LOCAL_KEK
    delete process.env.GRID_BYOK_SECRET_BACKEND
    delete process.env.WORKOS_API_KEY
  })

  it('round-trips a key', () => {
    const envelope = encryptLocal('org_1', 'cred-1', 'sk-super-secret')
    expect(envelope).not.toContain('sk-super-secret')
    expect(decryptLocal('org_1', 'cred-1', envelope)).toBe('sk-super-secret')
  })

  it('binds the ciphertext to org + credential (AAD)', () => {
    const envelope = encryptLocal('org_1', 'cred-1', 'sk-super-secret')
    // Replaying another tenant's ciphertext must fail the GCM tag check.
    expect(() => decryptLocal('org_2', 'cred-1', envelope)).toThrow()
    expect(() => decryptLocal('org_1', 'cred-other', envelope)).toThrow()
  })

  it('produces unique ciphertexts per encryption (fresh IV)', () => {
    const a = encryptLocal('org_1', 'cred-1', 'sk-super-secret')
    const b = encryptLocal('org_1', 'cred-1', 'sk-super-secret')
    expect(a).not.toBe(b)
  })

  it('rejects a malformed KEK', () => {
    process.env.GRID_BYOK_LOCAL_KEK = 'dG9vLXNob3J0'
    expect(() => encryptLocal('org_1', 'cred-1', 'sk-x')).toThrow(/32 bytes/)
  })

  it('fingerprint and hint never expose the key', () => {
    const fingerprint = keyFingerprint('sk-super-secret-abcd')
    expect(fingerprint).toHaveLength(16)
    expect(fingerprint).not.toContain('secret')
    expect(keyHint('sk-super-secret-abcd')).toBe('…abcd')
  })

  it('selects the backend from env with a vault default when WorkOS is configured', () => {
    expect(activeSecretBackend()).toBe('local-aes-gcm')
    process.env.WORKOS_API_KEY = 'sk_test'
    expect(activeSecretBackend()).toBe('workos-vault')
    process.env.GRID_BYOK_SECRET_BACKEND = 'local'
    expect(activeSecretBackend()).toBe('local-aes-gcm')
    process.env.GRID_BYOK_SECRET_BACKEND = 'vault'
    delete process.env.WORKOS_API_KEY
    expect(activeSecretBackend()).toBe('workos-vault')
  })
})
