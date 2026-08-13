/**
 * The BIM model read from one document — addressed by the DOCUMENT, on any shelf.
 *
 * Every other model surface is reached through a project
 * (`/api/projects/[id]/bim/models`), which is where the flag and the access
 * check live. A document in the org-wide Archiv has no project, so nothing
 * could resolve its model: the file uploaded fine, was parsed into a building,
 * and then had no surface anywhere in the Archiv that could find it. The
 * viewport in the file preview said "no model" about a model that exists.
 *
 * This is the missing question — "which model is THIS file" — and it is the one
 * the preview pane actually has the answer to. Authorization is the document's
 * own shelf rule (`getModelForDocument`), so a project file still goes through
 * per-project FGA and a chat attachment still needs the conversation.
 *
 * `{ model: null }` is a real answer, not a 404: a `.ifc` whose extraction is
 * still running, or a document that is not a model at all, has no model yet and
 * the caller has to be able to tell that apart from "you may not look".
 */

import { apiRoute } from '@/lib/api/handler'
import { getModelForDocument } from '@/lib/bim/model-service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({ model: await getModelForDocument(session, params.id) }),
  {
    authz: {
      enforcedBy: 'getModelForDocument (ifc-models flag + the document shelf rule)',
    },
  }
)
