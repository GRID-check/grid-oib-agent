/**
 * BIM model source API — a short-lived presigned URL for the raw `.ifc`.
 *
 * The 3D viewer parses and triangulates the model in the browser (ifc-lite's
 * WASM geometry kernel + WebGPU renderer), so this URL is the viewer's actual
 * input rather than a download convenience.
 */

import { apiRoute } from '@/lib/api/handler'
import { getModelSource } from '@/lib/bim/model-service'

type Params = { modelId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getModelSource(session, params.modelId),
  {
    authz: {
      enforcedBy:
        'getModelSource -> getAccessibleModel (ifc-models flag + requireProjectAccess project:view, or org membership for Archiv models)',
    },
  }
)
