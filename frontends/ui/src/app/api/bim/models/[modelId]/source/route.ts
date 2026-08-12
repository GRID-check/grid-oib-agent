/**
 * BIM model source API — a short-lived presigned URL for the raw `.ifc`.
 *
 * The 3D viewer parses and triangulates the model in the browser (ifc-lite's
 * WASM geometry kernel + WebGPU renderer), so this URL is the viewer's actual
 * input rather than a download convenience.
 */

import { NextResponse } from 'next/server'
import { apiRoute } from '@/lib/api/handler'
import { getModelSource } from '@/lib/bim/model-service'

type Params = { modelId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => {
    const source = await getModelSource(session, params.modelId)
    // Stated, not inherited. The body is a presigned object-storage
    // credential minted for ONE user and valid for ten minutes; whether a
    // framework default happens to send `private, no-cache` is not a thing to
    // find out from a shared cache. Every sibling route that hands out a
    // credential — the LLM credential, the widget token, the BCF export —
    // says so explicitly, and this was the one that did not.
    return NextResponse.json(source, { headers: { 'Cache-Control': 'no-store' } })
  },
  {
    authz: {
      enforcedBy:
        'getModelSource -> getAccessibleModel (ifc-models flag + requireProjectAccess project:view, or org membership for Archiv models)',
    },
  }
)
