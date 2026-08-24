/**
 * Knowledge-base source PDF — streams a base-corpus PDF for the in-app
 * viewer (clicked citations, knowledge page rows). Read-only; any
 * authenticated session, matching GET /api/knowledge-base.
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { streamKnowledgeBaseDocument } from '@/lib/knowledge/service'

export const GET = apiRoute<{ fileName?: string }>(
  async ({ params }) => {
    const fileName = typeof params.fileName === 'string' ? params.fileName : ''
    if (!fileName) throw new BadRequestError('Missing file name')
    return streamKnowledgeBaseDocument(fileName)
  },
  {
    authz: {
      sessionOnly: true,
      why: 'serves a document from the platform-owned base corpus, identical for every tenant',
    },
  }
)
