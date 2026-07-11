/**
 * Knowledge-base API — what the RAG currently knows (OIB base corpus).
 * Thin handler; all logic lives in `@/lib/knowledge/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getKnowledgeBaseStatus } from '@/lib/knowledge/service'

export const GET = apiRoute(async () => getKnowledgeBaseStatus())
