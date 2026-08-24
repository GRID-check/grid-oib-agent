/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { RESOURCE_ROLES, type ResourceRole } from '@/lib/db/schema/resource-shares'
import {
  composerCapabilities,
  roleMayContribute,
  type ComposerCapabilityInput,
} from './composer-capabilities'

/** A signed-in owner of a private thread, mid-idle: everything permitted. */
const PERMITTED: ComposerCapabilityInput = {
  isAuthenticated: true,
  canCollaborate: true,
  sharing: 'private',
  myRole: null,
  isBusy: false,
  isResponseMode: false,
  researchLocked: false,
  otherPersonsTurn: false,
}

const withInput = (patch: Partial<ComposerCapabilityInput>) =>
  composerCapabilities({ ...PERMITTED, ...patch })

describe('roleMayContribute', () => {
  test('ranks the ladder rather than matching a name', () => {
    expect(roleMayContribute('viewer')).toBe(false)
    expect(roleMayContribute('collaborator')).toBe(true)
    expect(roleMayContribute('owner')).toBe(true)
  })

  test('no role is not a contributing role', () => {
    expect(roleMayContribute(null)).toBe(false)
  })

  test('a role this client does not recognise is not trusted', () => {
    // The regression the name comparison allowed: `!== 'viewer'` waved through
    // anything unrecognised, including a role the server ranks below
    // collaborator. Ranking denies it instead.
    expect(roleMayContribute('commenter' as ResourceRole)).toBe(false)
  })

  test('the local ladder still matches the server ladder', () => {
    // `@/lib/sharing/registry` owns roleSatisfies but is `server-only`, so the
    // client mirrors the order. If RESOURCE_ROLES ever gains a rank, this fails
    // here rather than silently in a permission check.
    expect([...RESOURCE_ROLES]).toEqual(['viewer', 'collaborator', 'owner'])
  })
})

describe('composerCapabilities', () => {
  test('an idle owner may contribute and compose', () => {
    const caps = withInput({})
    expect(caps).toMatchObject({ canContribute: true, canCompose: true, deniedBy: null })
  })

  test('signed out denies contribution, by name', () => {
    expect(withInput({ isAuthenticated: false })).toMatchObject({
      canContribute: false,
      canCompose: false,
      deniedBy: 'unauthenticated',
    })
  })

  test('a viewer in a shared thread is read-only, by name', () => {
    expect(withInput({ sharing: 'shared', myRole: 'viewer' })).toMatchObject({
      canContribute: false,
      canCompose: false,
      deniedBy: 'read-only-role',
    })
  })

  test('a collaborator in a shared thread keeps everything', () => {
    expect(withInput({ sharing: 'shared', myRole: 'collaborator' })).toMatchObject({
      canContribute: true,
      canCompose: true,
      deniedBy: null,
    })
  })

  describe('a denial of contribution always denies composing', () => {
    // InputArea guarded write controls on `cannotContribute` and submit on
    // `disabled`, which was only correct because the first implies the second.
    // Nothing stated or tested that. Now it is a property of one function.
    for (const patch of [
      { isAuthenticated: false },
      { sharing: 'shared' as const, myRole: 'viewer' as ResourceRole },
    ]) {
      test(JSON.stringify(patch), () => {
        const caps = withInput(patch)
        expect(caps.canContribute).toBe(false)
        expect(caps.canCompose).toBe(false)
      })
    }
  })

  describe('composing is narrower than contributing', () => {
    for (const [label, patch] of [
      ['a turn is running', { isBusy: true }],
      ['research finished', { researchLocked: true }],
      ["somebody else's turn", { otherPersonsTurn: true }],
    ] as const) {
      test(`${label}: may still contribute, may not compose`, () => {
        const caps = withInput(patch)
        expect(caps.canContribute).toBe(true)
        expect(caps.canCompose).toBe(false)
        expect(caps.deniedBy).toBeNull()
      })
    }

    test('response mode reopens the composer during a turn', () => {
      expect(withInput({ isBusy: true, isResponseMode: true }).canCompose).toBe(true)
    })
  })

  describe('an unpublished role in a shared thread', () => {
    const caps = withInput({ sharing: 'shared', myRole: null })

    test('is reported as unknown', () => {
      expect(caps.roleUnknown).toBe(true)
    })

    test('CURRENTLY still permits contribution — see the module header', () => {
      // Pins today's behaviour rather than endorsing it. useThreadRole is
      // published by a sibling component, so this window lasts for the access
      // round-trip and forever if that sibling never mounts. Flipping this to a
      // denial is a deliberate product change; when it happens, this assertion
      // is the one that should fail first.
      expect(caps.canContribute).toBe(true)
      expect(caps.deniedBy).toBeNull()
    })

    test('a private thread with no role is not "unknown"', () => {
      // Absent role on a private thread is normal, not a pending read.
      expect(withInput({ sharing: 'private', myRole: null }).roleUnknown).toBe(false)
    })
  })

  describe('typing presence', () => {
    test('is broadcast only in a shared thread by someone who may contribute', () => {
      expect(
        withInput({ sharing: 'shared', myRole: 'collaborator' }).canBroadcastTyping,
      ).toBe(true)
    })

    test('a viewer never announces a draft that cannot become a message', () => {
      expect(withInput({ sharing: 'shared', myRole: 'viewer' }).canBroadcastTyping).toBe(
        false,
      )
    })

    test('a private thread issues no presence request at all (NF-8)', () => {
      expect(withInput({ sharing: 'private' }).canBroadcastTyping).toBe(false)
    })

    test('collaboration off issues no presence request at all (NF-8)', () => {
      expect(
        withInput({ canCollaborate: false, sharing: 'shared', myRole: 'collaborator' })
          .canBroadcastTyping,
      ).toBe(false)
    })
  })
})
