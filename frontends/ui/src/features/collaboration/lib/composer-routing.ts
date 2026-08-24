/**
 * Where the message in the composer goes — stated once, for both the addressee
 * line and the send.
 *
 * These were two independent expressions of one decision. The line derived its
 * mode inside `AddresseeIndicator` from `reconcileMentions(message, …)`; the
 * send re-derived a three-way branch inside `handleSubmit` from
 * `reconcileMentions(message.trim(), …)`. A comment on the send claimed the two
 * "cannot disagree", which was true of the hand-off flag it pointed at and false
 * of everything else: two reconciliations, two different strings, two shapes.
 * Twenty-one tests were what kept them aligned, which makes those tests
 * scaffolding around a latent divergence rather than a specification of it.
 *
 * Two divergences already existed:
 *
 *   1. The LINE is gated on `canCollaborate`; the SEND was not. Mention state
 *      can be populated with the flag off (a prefill seeds it without consulting
 *      the flag), so a prefill carrying mentions took the ruled path — sharing
 *      the thread server-side, standing the agent down — while the composer said
 *      nothing at all, because the line that would have said so was not
 *      rendered. `canCollaborate` is now an input to the routing itself, so the
 *      flag-off path is exactly the pre-feature call. Latent rather than live
 *      today, since the only mention-carrying prefill is itself
 *      collaboration-only; it goes live the moment any other surface queues one.
 *
 *   2. The two reconciled different strings. Leading and trailing whitespace is
 *      boundary-equivalent to string start and end in `mention-text`, so trim is
 *      currently neutral — but nothing forced that, and a future change to
 *      boundary handling would have broken the agreement silently. Reconciled
 *      once here, against the trimmed text, which is what is actually sent.
 *
 * Pure by construction: no React, no store, no i18n. The label is still the
 * indicator's job — this module decides, it does not phrase.
 */

import {
  humanMentions,
  reconcileMentions,
  type DraftMention,
} from './mention-text'

/** Which of the three statements the addressee line makes. */
export type AddresseeMode = 'agent' | 'people' | 'thread'

/**
 * How `sendMessage` must be called. The one description of the send's shape —
 * `fast` is the pre-feature single-argument call and must stay literally that,
 * because three tests assert on argument arity and because passing an explicit
 * `undefined` would push plain messages down the server's ruling path.
 */
export type SendRouting =
  | { readonly kind: 'fast' }
  | { readonly kind: 'mentions'; readonly mentions: DraftMention[] }
  | { readonly kind: 'awaiting' }

export interface AddresseeInput {
  /** The composer text exactly as the textarea holds it; trimmed here, once. */
  readonly text: string
  /** The mentions the user PICKED — never derived from the text (spec MN-3). */
  readonly mentions: readonly DraftMention[]
  /** Server-derived hand-off state (ADR-0034); never computed locally. */
  readonly awaitingHuman: boolean
  /** Collaboration reachable for this deployment. False ⇒ exactly pre-feature. */
  readonly canCollaborate: boolean
}

export interface Addressee {
  /** Mentions surviving the text, in text order — exactly what is sent. */
  readonly mentions: DraftMention[]
  /** …of which these address a person; drives the "Piloti stays quiet" hint. */
  readonly humans: DraftMention[]
  /** `@Piloti` is among them, so the agent answers too (spec MN-1). */
  readonly agentTagged: boolean
  /** What the line says. */
  readonly mode: AddresseeMode
  /** What the send does. Cannot disagree with `mode` — same derivation. */
  readonly routing: SendRouting
}

/**
 * Resolve who this message goes to.
 *
 * Tagging beats the thread state: the message being written decides where it
 * goes, and `@Piloti` is the documented way back out of a wait (MN-9.3).
 */
export function resolveAddressee(input: AddresseeInput): Addressee {
  // With collaboration off there is nothing to reconcile against and no line to
  // render: the composer behaves exactly as it did before mentions existed.
  if (!input.canCollaborate) {
    return {
      mentions: [],
      humans: [],
      agentTagged: false,
      mode: 'agent',
      routing: { kind: 'fast' },
    }
  }

  const mentions = reconcileMentions(input.text.trim(), input.mentions)
  const humans = humanMentions(mentions)
  const agentTagged = mentions.length > humans.length

  const mode: AddresseeMode =
    humans.length > 0 ? 'people' : agentTagged || !input.awaitingHuman ? 'agent' : 'thread'

  const routing: SendRouting =
    mentions.length > 0
      ? { kind: 'mentions', mentions }
      : input.awaitingHuman
        ? { kind: 'awaiting' }
        : { kind: 'fast' }

  return { mentions, humans, agentTagged, mode, routing }
}

/**
 * The second argument to `sendMessage`, or `undefined` for the fast path.
 *
 * `undefined` means the caller must omit the argument entirely rather than pass
 * it — `sendMessage(text, undefined)` would fail the three
 * `toHaveBeenCalledWith(text)` assertions AND, in production, route a plain
 * message through the server's ruling. The call site spells that out in one
 * ternary; what it must NOT do is re-derive which case it is in.
 */
export function sendMessageOptions(
  routing: SendRouting,
): { mentions: DraftMention[] } | { awaitingHuman: true } | undefined {
  switch (routing.kind) {
    case 'mentions':
      return { mentions: routing.mentions }
    case 'awaiting':
      return { awaitingHuman: true }
    case 'fast':
      return undefined
  }
}
