/**
 * The project mail inbox wire contract: what the two project routes answer,
 * and the headers the webhook and the Cloudflare Email Worker agree on.
 *
 * Client-safe by construction (zod only, no `server-only`, no db), because the
 * settings surface and the routes read the same file.
 */

import { z } from 'zod'

/**
 * `GET /api/projects/[id]/inbound-address`.
 *
 * `enabled` is false when the deployment has no inbound mail domain or the
 * organization's `project-mail-inbox` switch is off; `address` is then null. A caller without document write access on the project gets a
 * 404 rather than this body. `canRotate` says whether the caller holds
 * `project:manage`.
 */
export const inboundAddressResponseSchema = z.object({
  enabled: z.boolean(),
  address: z.string().nullable(),
  canRotate: z.boolean(),
})
export type InboundAddressResponse = z.infer<typeof inboundAddressResponseSchema>

/** `POST /api/projects/[id]/inbound-address/rotate`: the freshly minted address. */
export const rotateInboundAddressResponseSchema = z.object({
  address: z.string(),
})
export type RotateInboundAddressResponse = z.infer<typeof rotateInboundAddressResponseSchema>

/**
 * The Worker ↔ webhook contract (`deploy/pulumi/src/platform/inbound-mail-worker.js`
 * holds the same three names; it is plain JS outside this package, so they are
 * restated there rather than imported).
 *
 * The Worker bounces a mail ONLY when the answer is a 4xx carrying
 * `x-inbound-verdict: reject`. Every other answer, including a 4xx without it,
 * makes it throw so the sending server retries: a misrouted URL, a rotated
 * token or a proxy's 404 can never bounce a member's mail.
 */
export const INBOUND_ENVELOPE_TO_HEADER = 'x-envelope-to'
export const INBOUND_VERDICT_HEADER = 'x-inbound-verdict'
export const INBOUND_VERDICT_REJECT = 'reject'
/** `message.rawSize`, in decimal bytes: a streamed body carries no Content-Length. */
export const INBOUND_RAW_SIZE_HEADER = 'x-inbound-raw-size'
