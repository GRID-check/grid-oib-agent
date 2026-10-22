import 'server-only'
/**
 * The session an agent call runs as (ADR-0122).
 *
 * Piloti's MCP server reaches the workspace through the same route handlers a
 * browser does, so every rule that lives at a route (the `authz` declaration,
 * the rate limit, the tenant slot, the body schema) applies to an agent too.
 * Those handlers learn who is asking from ONE function, `getGridSession()`,
 * which reads the AuthKit cookie. An agent has no cookie. This module is the
 * other answer `getGridSession()` may give: the person the MCP endpoint already
 * authenticated and resolved, bound to the async execution of one call.
 *
 * Only `lib/agent-api/dispatch.ts` enters it, and only with a session built by
 * `resolvePinnedRequesterSession`: the person's membership, role and
 * permissions as WorkOS states them now (ADR-0108). Nothing a request carries
 * can enter it, because no code reachable from a request passes a value to
 * {@link runAsActingSession} that it did not resolve itself.
 *
 * `AsyncLocalStorage.run` bounds the binding to the callback, so a call cannot
 * leak its person into the next request on the same socket.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthorizedSession } from '@/lib/auth/types'

/**
 * Who reads the route's answer. `agent`: an agent called the operation (MCP), so
 * whatever the route words (a refusal, a label) is read by a model and is
 * English, whatever the person's saved locale; the model words it for the
 * reader. `person`: a person applied a proposal, and reads the route's words in
 * their own language. Read by `getLocale()` (`i18n/server.ts`).
 */
export type ActingReader = 'agent' | 'person'

interface ActingCall {
  readonly session: AuthorizedSession
  readonly reader: ActingReader
  /** The Piloti proposal the person accepted, when the call is that acceptance applied (ADR-0105). */
  readonly proposalId?: string
}

/** What else the call carries besides the person: the proposal it applies, if it applies one. */
export interface ActingOrigin {
  readonly proposalId?: string
}

const acting = new AsyncLocalStorage<ActingCall>()

/** Run `fn` with `session` as the answer `getGridSession()` gives. */
export function runAsActingSession<T>(
  session: AuthorizedSession,
  fn: () => Promise<T>,
  reader: ActingReader = 'person',
  origin: ActingOrigin = {},
): Promise<T> {
  return acting.run({ session, reader, ...(origin.proposalId ? { proposalId: origin.proposalId } : {}) }, fn)
}

/** The session bound by {@link runAsActingSession}, or `undefined` outside one. */
export function currentActingSession(): AuthorizedSession | undefined {
  return acting.getStore()?.session
}

/** Whether the call in flight is an agent's, whose answer a model reads ({@link ActingReader}). */
export function actingReaderIsAgent(): boolean {
  return acting.getStore()?.reader === 'agent'
}

/**
 * The Piloti proposal whose acceptance the call in flight applies, or
 * `undefined`. A route that records HOW a person decided (an E-Mail-Eingang
 * decision's `via`, ADR-0134) reads it: a card Piloti worded may not carry an
 * acknowledgement or a release, which the person gives only in the app or as
 * themselves (RT-S5). Set only by the proposal applier, through `callOperation`.
 */
export function actingProposalId(): string | undefined {
  return acting.getStore()?.proposalId
}
