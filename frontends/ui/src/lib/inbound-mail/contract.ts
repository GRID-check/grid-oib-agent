/**
 * The project mail inbox wire contract: what the two project routes answer.
 *
 * Client-safe by construction (zod only, no `server-only`, no db), because the
 * settings surface and the routes read the same file.
 */

import { z } from 'zod'

/**
 * `GET /api/projects/[id]/inbound-address`.
 *
 * `enabled` is false when the deployment has no inbound mail domain; `address`
 * is then null. A caller without document write access on the project gets a
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
