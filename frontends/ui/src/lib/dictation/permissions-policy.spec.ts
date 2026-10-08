/**
 * Voice dictation needs the microphone, and the browser asks the
 * Permissions-Policy header before it asks the member. A policy of
 * `microphone=()` refuses `getUserMedia` with the same NotAllowedError a member
 * clicking "Block" produces, so the feature looks broken by the user, not by
 * us. This pins the header the server actually sends.
 */
import { describe, expect, test } from 'vitest'
import nextConfig from '../../../next.config'

async function permissionsPolicy(): Promise<string | undefined> {
  const rules = (await nextConfig.headers?.()) ?? []
  const global = rules.find((rule) => rule.source === '/(.*)')
  return global?.headers.find((header) => header.key === 'Permissions-Policy')?.value
}

describe('Permissions-Policy', () => {
  test('lets our own pages use the microphone, and nothing else', async () => {
    const policy = await permissionsPolicy()
    expect(policy).toContain('microphone=(self)')
    expect(policy).toContain('camera=()')
    expect(policy).toContain('geolocation=()')
  })
})
