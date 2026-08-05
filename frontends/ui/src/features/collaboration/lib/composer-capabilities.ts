/**
 * What the composer may do, as one named decision per capability.
 *
 * This existed inline in InputArea as two ad-hoc booleans (`cannotContribute`,
 * `disabled`) built from a role-NAME comparison:
 *
 *     const isViewerInSharedThread = myThreadRole === 'viewer'
 *
 * Three things were wrong with that, and they are the reason this module exists
 * rather than the (real, but small) test-speed win.
 *
 * 1. It compares a role name where the rest of the codebase compares a ladder.
 *    `lib/authz/permissions.ts` states the contract — authorization is
 *    permission-driven, never "is the role called admin?" — and the conversation
 *    tier has the matching primitive in `roleSatisfies(role, minimum)`. That
 *    module is `server-only`, so a client component could not reach it and
 *    invented a name check instead. The consequence is silent: add a
 *    conversation role below `collaborator` and `!== 'viewer'` waves it through
 *    every composer gate, while the server still rejects the send. That is the
 *    exact failure ADR-0038 exists to prevent, reproduced one layer up.
 *    `roleMayContribute` below is a client-side mirror of the server's ladder,
 *    so a new role is ranked rather than accidentally trusted.
 *
 * 2. Every denial was anonymous. ADR-0038 requires a decision to name the rule
 *    that produced it "so a bypass can never be silent", and the viewer notice
 *    in the composer had to re-derive `isViewerInSharedThread` to explain a lock
 *    that a bare boolean OR had produced. `deniedBy` carries the reason.
 *
 * 3. `roleUnknown` was invisible. `useThreadRole` returns null until a SIBLING
 *    component publishes it, so `null === 'viewer'` is false and the composer
 *    stays live for the whole access round-trip — and forever if that sibling
 *    never mounts. That is the opposite of the choice `thread-sharing.ts` makes
 *    one level down, where unknown sharedness deliberately fails closed and the
 *    header explains why.
 *
 *    This module PRESERVES today's allow-while-unknown behaviour exactly. It is
 *    surfaced as a field rather than changed, because whether a viewer's
 *    composer should be live while their role loads is a product call. What
 *    changes is that it is now a decision with a name and a test, instead of an
 *    emergent property of `null !== 'viewer'`. Flipping it is a one-line change
 *    in `composerCapabilities` plus the assertion that pins it.
 *
 * Pure by construction: no React, no store, no i18n. Everything live — busy
 * state, turn ownership, sharing, role — arrives as a parameter.
 */

import type { ResourceRole } from '@/lib/sharing/types'
import type { ThreadSharing } from '@/shared/collaboration/thread-sharing'

/**
 * The conversation role ladder, weakest first — the same order as
 * `RESOURCE_ROLES` in `@/lib/db/schema`, which owns it. Duplicated here rather
 * than imported because that module is reachable only through `server-only`
 * code; `roleLadderMatchesServer` in the spec is what keeps the two honest.
 */
const ROLE_LADDER: readonly ResourceRole[] = ['viewer', 'collaborator', 'owner']

/** The minimum role that may change anything about a conversation. */
const MINIMUM_CONTRIBUTOR_ROLE: ResourceRole = 'collaborator'

/**
 * Whether a known role may contribute. A ladder comparison, not a name test, so
 * a role added below `collaborator` is denied rather than silently permitted.
 *
 * `null` returns false — "no role" is not "may contribute". Callers decide what
 * an ABSENT role means, because absent and known-too-weak are different facts:
 * see `roleUnknown` in `composerCapabilities`.
 */
export function roleMayContribute(role: ResourceRole | null): boolean {
  if (role === null) return false
  const rank = ROLE_LADDER.indexOf(role)
  const minimum = ROLE_LADDER.indexOf(MINIMUM_CONTRIBUTOR_ROLE)
  // An unrecognised role ranks -1: unknown to this client, so not trusted.
  return rank >= 0 && rank >= minimum
}

/** The named rule behind a denial, so no gate is anonymous (ADR-0038). */
export type ComposerDenial =
  /** Not signed in. */
  | 'unauthenticated'
  /** Role is known and ranks below `collaborator`. */
  | 'read-only-role'

export interface ComposerCapabilityInput {
  readonly isAuthenticated: boolean
  /** Collaboration reachable for this deployment (spec NF-8). */
  readonly canCollaborate: boolean
  /** Sharedness of the thread, or `'unknown'` before the access read lands. */
  readonly sharing: ThreadSharing
  /** The reader's role, or null while it has not been published. */
  readonly myRole: ResourceRole | null
  /** A turn is running. */
  readonly isBusy: boolean
  /** The composer is collecting a response to a question the agent asked. */
  readonly isResponseMode: boolean
  /** A finished research session locks further input. */
  readonly researchLocked: boolean
  /** Somebody else holds the turn. */
  readonly otherPersonsTurn: boolean
}

export interface ComposerCapabilities {
  /**
   * May change ANYTHING about this conversation — files, Datengrundlage,
   * presets, mentions, stop. Was `!cannotContribute`.
   */
  readonly canContribute: boolean
  /**
   * May type and press send right now. Strictly narrower than `canContribute`:
   * a contributor still cannot compose mid-turn. Was `!disabled`.
   */
  readonly canCompose: boolean
  /**
   * May broadcast a typing claim. Only where someone could see it and where the
   * draft could actually become a message.
   */
  readonly canBroadcastTyping: boolean
  /** The rule that denied contribution, or null. */
  readonly deniedBy: ComposerDenial | null
  /**
   * The thread is shared but the role has not arrived. Today this ALLOWS
   * contribution — see the module header. Exposed so the choice is visible and
   * pinned by a test rather than emerging from a null comparison.
   */
  readonly roleUnknown: boolean
}

/**
 * Resolve the composer's capabilities. Total, pure, no React.
 *
 * `canContribute ⟹ canCompose` is false, but `!canContribute ⟹ !canCompose`
 * holds: contribution denials also block composing. InputArea relied on that
 * implication without stating it — write controls guarded on `cannotContribute`
 * while submit guarded on `disabled` — and the spec asserts it directly.
 */
export function composerCapabilities(
  input: ComposerCapabilityInput,
): ComposerCapabilities {
  const roleUnknown = input.sharing === 'shared' && input.myRole === null

  const deniedBy: ComposerDenial | null = !input.isAuthenticated
    ? 'unauthenticated'
    : // A role we have is ranked. A role we do NOT have is deliberately not a
      // denial today — preserving the previous `myThreadRole === 'viewer'`
      // behaviour, where null was not 'viewer' and so never locked anything.
      input.myRole !== null && !roleMayContribute(input.myRole)
      ? 'read-only-role'
      : null

  const canContribute = deniedBy === null

  const canCompose =
    canContribute &&
    !(input.isBusy && !input.isResponseMode) &&
    !input.researchLocked &&
    !input.otherPersonsTurn

  const canBroadcastTyping =
    input.canCollaborate && input.sharing === 'shared' && canContribute

  return { canContribute, canCompose, canBroadcastTyping, deniedBy, roleUnknown }
}
