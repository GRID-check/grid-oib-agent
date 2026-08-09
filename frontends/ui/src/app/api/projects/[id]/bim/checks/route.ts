/**
 * Human verdicts on the OIB rule catalogue.
 *
 * The catalogue settles what the model's published values can settle; the rest
 * an architect settles by reading a plan or asking a Brandschutzplaner. This is
 * where that judgement is recorded, against the revision they looked at.
 *
 * The confirming identity is taken from the SESSION, never from the body — a
 * signature a caller could address to somebody else is not a signature.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import {
  confirmAccessibleCheck,
  listAccessibleCheckConfirmations,
  withdrawAccessibleCheck,
} from '@/lib/bim/model-service'

type Params = { id: string }

const RULE_ID = z.string().trim().min(1).max(120)

const confirmSchema = z.object({
  ruleId: RULE_ID,
  /** The revision the person looked at; re-resolved against the tenant. */
  modelId: z.string().uuid(),
  note: z.string().trim().max(2000).nullish(),
})

const withdrawSchema = z.object({ ruleId: RULE_ID })

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    confirmations: await listAccessibleCheckConfirmations(session, params.id),
  }),
  {
    authz: {
      enforcedBy: 'listAccessibleCheckConfirmations (ifc-models flag + project:view)',
    },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, confirmSchema)
    await confirmAccessibleCheck(session, params.id, {
      ruleId: body.ruleId,
      modelId: body.modelId,
      note: body.note ?? null,
    })
    return { ok: true }
  },
  {
    authz: {
      enforcedBy: 'confirmAccessibleCheck (ifc-models flag + project:edit + model tenancy)',
    },
  }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, withdrawSchema)
    await withdrawAccessibleCheck(session, params.id, body.ruleId)
    return { ok: true }
  },
  {
    authz: { enforcedBy: 'withdrawAccessibleCheck (ifc-models flag + project:edit)' },
  }
)
