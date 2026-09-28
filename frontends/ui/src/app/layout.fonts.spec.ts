/**
 * Which fonts the root layout asks the browser to preload.
 *
 * `next/font` preloads a font on every route unless told not to, and a
 * preloaded file that the first paint does not use is a console warning on
 * every page load ("was preloaded using link preload but not used within a few
 * seconds"). The body face is on every first paint; mono is not.
 */
import { describe, expect, test, vi } from 'vitest'

const fontOptions = vi.hoisted(() => new Map<string, Record<string, unknown>>())

vi.mock('next/font/google', () => {
  const font = (name: string) => (options: Record<string, unknown>) => {
    fontOptions.set(name, options)
    return { className: name, variable: String(options.variable), style: {} }
  }
  return { Geist: font('Geist'), Geist_Mono: font('Geist_Mono') }
})
vi.mock('./providers', () => ({ Providers: () => null }))
vi.mock('./chunk-reload-guard', () => ({ ChunkReloadGuard: () => null }))
vi.mock('@/components/shell/navigation-trail', () => ({ NavigationTrail: () => null }))
vi.mock('@/lib/auth/session', () => ({ getGridSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ runWithTenantSlot: vi.fn() }))
vi.mock('@/lib/documents/vlm-capability', () => ({ isVlmConfigured: vi.fn() }))
vi.mock('@/i18n/server', () => ({ getLocale: vi.fn() }))

describe('root layout fonts', () => {
  test('preloads the body face and not the mono face', async () => {
    await import('./layout')

    expect(fontOptions.get('Geist')?.preload).not.toBe(false)
    expect(fontOptions.get('Geist_Mono')?.preload).toBe(false)
  })
})
