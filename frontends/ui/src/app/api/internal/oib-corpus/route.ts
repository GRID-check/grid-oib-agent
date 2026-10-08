/**
 * The OIB base corpus as one .tar.gz. Its only consumer was the answer-suite
 * CI workflow, which has been removed; `task be:eval:answer-suite` ingests
 * data/oib from disk and never calls this route. It stays until someone decides
 * to delete the export path.
 *
 * Guarded by its OWN secret, `GRID_CORPUS_EXPORT_TOKEN`, in the
 * `x-grid-internal-token` header, not the shared service token: this one lives
 * outside the cluster, in a repository secret, so a leak opens this route and
 * nothing else. Fail-closed like every internal route: unset, 503.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { streamKnowledgeBaseCorpus } from '@/lib/knowledge/service'

export const GET = internalApiRoute('oib-corpus', async () => streamKnowledgeBaseCorpus(), {
  tenancy: { crossTenant: 'the platform base corpus — reads no tenant rows' },
  tokenEnv: 'GRID_CORPUS_EXPORT_TOKEN',
})
