/**
 * The OIB base corpus as one .tar.gz, for CI: the answer-suite workflow
 * (`.github/workflows/answer-suite.yml`) ingests it to run the reference
 * questions against the corpus production indexes.
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
