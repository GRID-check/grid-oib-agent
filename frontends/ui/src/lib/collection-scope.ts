import type { GridSession } from './auth/types'

export interface ScopeContext {
  projectId?: string
  projectCollectionName?: string
  includeProject?: boolean
  conversationId?: string
  baseCollection?: string
}

export function computeCollectionScope(
  _session: GridSession | null,
  context: ScopeContext,
): string[] {
  const scope: string[] = []
  const base = context.baseCollection || process.env.BASE_COLLECTION_NAME || 'oib_knowledge'
  scope.push(base)

  if (context.includeProject !== false) {
    const projectCollectionName = context.projectCollectionName || (context.projectId ? `proj_${context.projectId}` : undefined)
    if (projectCollectionName) {
      scope.push(projectCollectionName)
    }
  }

  if (context.conversationId) {
    scope.push(context.conversationId.startsWith('s_') ? context.conversationId : `s_${context.conversationId}`)
  }

  return [...new Set(scope)]
}

export function buildCollectionScopeHeader(scope: string[]): string {
  return Buffer.from(JSON.stringify(scope)).toString('base64url')
}
