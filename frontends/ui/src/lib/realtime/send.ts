/**
 * Saying something in a live channel (ADR-0110): `POST /api/realtime/send`.
 *
 * In order, so a refusal costs as little as possible and a sender can never
 * speak as somebody else:
 *
 * 1. The key names a channel that takes messages (400 otherwise).
 * 2. The session may send there: the channel's `authorizeSend` (or
 *    `authorize`), remembered for its `reauthorizeMs` (`./channel`).
 * 3. The channel's rate limit is spent, per member and channel (429 when
 *    gone): a claim (presence, the selected mark) from its own budget, the
 *    rest (motion) from the channel's, so motion never refuses a claim.
 * 4. The message parses as the channel's upstream vocabulary (400).
 * 5. The peer is stamped from the session (`userId`, `name`, `kind`); the
 *    client contributes only its tab's `peerId`.
 * 6. A presence claim and the channel's own events are published on its topic,
 *    and the channel may note them (the server roster).
 */

import 'server-only'
import { ZodError } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { enforceLimit, memberSubject } from '@/lib/limits'
import { authorizeSendCached, type AnyChannel } from './channel'
import { publish } from './hub'
import { CHANNELS, resolveChannel } from './registry'
import { selfOf } from './stream'
import type { PresenceEvent, RealtimePeer, SendBody, UpstreamBase } from './types'

export async function sendToChannel(
  session: AuthorizedSession,
  { ch, msg }: SendBody,
  channels: Readonly<Record<string, AnyChannel>> = CHANNELS
): Promise<null> {
  const resolved = resolveChannel(ch, channels)
  const upstream = resolved?.channel.upstream
  if (!resolved || !upstream) throw new BadRequestError('This channel takes no messages.')
  const { channel, params } = resolved

  await authorizeSendCached(session, channel, params, ch)
  const rule = upstream.claims && carriesClaim(msg, upstream.claims.fields) ? upstream.claims.limit : upstream.limit
  await enforceLimit(rule, `${memberSubject(session)}:${ch}`)

  let post: UpstreamBase
  try {
    post = upstream.schema.parse(msg)
  } catch (error) {
    if (error instanceof ZodError) throw new BadRequestError('Invalid message', error.issues)
    throw error
  }

  const peer: RealtimePeer = { ...selfOf(session), peerId: post.peerId }
  const events: Array<{ kind: string }> = []
  if (post.presence && channel.presence) {
    const claim: PresenceEvent = { kind: 'presence', peer, state: post.presence, ttlMs: channel.presence.ttlMs }
    events.push(claim)
  }
  events.push(...upstream.handle(post, peer, params))

  const [topic] = channel.topics(params, session.organizationId)
  for (const event of events) await publish(topic, event)
  channel.observe?.(events, params, session.organizationId)
  return null
}

/**
 * Whether a message carries a claim: `presence`, or one of the channel's claim
 * `fields`. Read off the raw message, so the limit is still spent before the
 * message is parsed. Motion that rides along with a claim spends the claim
 * budget, which bounds it as well.
 */
function carriesClaim(msg: unknown, fields: readonly string[] = []): boolean {
  if (typeof msg !== 'object' || msg === null) return false
  return 'presence' in msg || fields.some((field) => field in msg)
}
