/**
 * `findProjectProfile` hands out a profile every reader can use as one.
 *
 * `projects.profile` is `jsonb NOT NULL DEFAULT '{}'`, so a project whose
 * intake was never saved stores `{}`. Returned raw, that reached
 * `answersFromProfile` as a `ProjectProfile` and threw on
 * `Object.keys(profile.facts)`: binding Bestandspläne to a building during a
 * first intake answered 500 „Internal server error“.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

import { getDb } from '@/lib/db'
import { runWithTenantSlot } from '@/lib/db/tenant-context'
import {
  answersFromProfile,
  projectIntakeDefinitionV1,
} from '@/lib/project-profile/intake-definition'
import { asDb } from '@/test-utils/db-fixtures'
import { findProjectProfile } from './repository'

/** A drizzle stand-in whose every chain resolves to `rows`. */
function dbReturning(rows: unknown[]) {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve)
        }
        return () => proxy
      },
    }
  )
  return proxy
}

function storedProfile(profile: unknown) {
  vi.mocked(getDb).mockReturnValue(asDb(dbReturning([{ profile }]) as Record<string, unknown>))
  return runWithTenantSlot(() => findProjectProfile('proj-1', 'org-1'))
}

describe('findProjectProfile', () => {
  beforeEach(() => vi.mocked(getDb).mockReset())

  it('turns the never-saved default into an empty profile with the implicit first building', async () => {
    const profile = await storedProfile({})

    expect(profile).toEqual({ facts: {}, goals: {}, unknowns: [], assumptions: {} })
    expect(answersFromProfile(profile!, projectIntakeDefinitionV1).bauwerke).toEqual([
      { id: 'bw1', name: 'Bauwerk 1' },
    ])
  })

  it('keeps the well-formed parts of a partly malformed profile', async () => {
    const fact = {
      value: 'wien',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-09-30T00:00:00Z',
    }
    const profile = await storedProfile({ facts: { bundesland: fact, broken: 3 } })

    expect(profile?.facts).toEqual({ bundesland: fact })
    expect(profile?.unknowns).toEqual([])
  })

  it('answers null when the project does not exist', async () => {
    vi.mocked(getDb).mockReturnValue(asDb(dbReturning([]) as Record<string, unknown>))
    expect(await runWithTenantSlot(() => findProjectProfile('proj-1', 'org-1'))).toBeNull()
  })
})
