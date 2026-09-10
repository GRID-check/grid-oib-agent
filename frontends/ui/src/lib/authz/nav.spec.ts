/**
 * @vitest-environment node
 */

/**
 * The nav flags are the one place a feature flag becomes a door in the chrome,
 * so what they answer for a session WITHOUT the flag matters as much as what
 * they answer with it — a nav entry that appears for everyone is how a
 * dark-launched surface leaks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridSession } from '@/lib/auth/types'
import { FEATURE_FLAGS } from './feature-flags'

vi.mock('./organizations', () => ({ isOrgAdmin: () => false }))
vi.mock('./platform', () => ({ isPlatformStaff: async () => false }))
vi.mock('@/lib/inbox/registry', () => ({ inboxIsReachable: () => true }))

const { getNavFlags } = await import('./nav')

const session = (flags: string[], permissions: string[] = ['org:chat']): GridSession =>
  ({
    userId: 'user_1',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    featureFlags: flags,
    permissions,
  }) as unknown as GridSession

describe('getNavFlags', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    // Enforcement on: without it every flag reads as enabled (back-compat), and
    // the negative case below would be untestable.
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
  })

  it('opens the Büro when the org has the flag AND the member may chat', async () => {
    const flags = await getNavFlags(session([FEATURE_FLAGS.workspaceChat]))
    expect(flags.canAccessWorkspaceChat).toBe(true)
  })

  it('keeps it shut for a member whose role withholds org:chat', async () => {
    // The flag alone used to open this door, which made two ordinary states
    // render a rail entry, a palette command and a `g b` jump that all bounce
    // to /app/projects: a role deliberately withholding `org:chat` (a
    // configuration the catalog names), and every session in an environment
    // where `provision:authz --apply` has not run yet.
    const flags = await getNavFlags(session([FEATURE_FLAGS.workspaceChat], []))
    expect(flags.canAccessWorkspaceChat).toBe(false)
  })

  it('keeps it shut for an org that does not', async () => {
    const flags = await getNavFlags(session([FEATURE_FLAGS.orgArchiv]))
    expect(flags.canAccessWorkspaceChat).toBe(false)
  })

  it('keeps it shut with no session at all', async () => {
    const flags = await getNavFlags(null)
    expect(flags.canAccessWorkspaceChat).toBe(false)
  })
})
