/**
 * From a file into the SAME Ask Piloti the rest of the product uses.
 *
 * The filename must appear in the user-visible question. The agent
 * retrieves by name in that text; a silent subject id is not enough.
 */

export function documentAskQuestion(name: string, kind: 'open' | 'keyPoints' | 'oib' = 'open'): string {
  switch (kind) {
    case 'keyPoints':
      return `Was sind die Kernaussagen in „${name}“?`
    case 'oib':
      return `Welche OIB-Stellen gelten für „${name}“?`
    default:
      return `Was steht in „${name}“?`
  }
}

export function documentQuestionHref(
  projectId: string,
  documentId: string,
  options: { ask?: string; filename?: string } = {},
): string {
  const params = new URLSearchParams({ new: '1', doc: documentId })
  if (options.ask) params.set('ask', options.ask)
  if (options.filename) params.set('file', options.filename)
  return `/app/projects/${encodeURIComponent(projectId)}/chat?${params.toString()}`
}

export function documentFilesHref(projectId: string, documentId: string): string {
  return `/app/projects/${encodeURIComponent(projectId)}/files?doc=${encodeURIComponent(documentId)}`
}

export function fileItemFromStatus(body: {
  id: string
  filename: string
  displayName?: string | null
  fileSize?: number | null
  contentType?: string | null
  status?: string | null
  createdAt?: string | Date
  errorMessage?: string | null
  summary?: string | null
  pageCount?: number | null
  chunkCount?: number | null
  contentTypes?: string[] | null
  tags?: string[] | null
}): {
  id: string
  filename: string
  displayName: string | null
  fileSize: number | null
  contentType: string | null
  status: string | null
  folderId: null
  createdAt: string
  errorMessage: string | null
  summary: string | null
  pageCount: number | null
  chunkCount: number | null
  contentTypes: string[] | null
  tags: string[] | null
} {
  return {
    id: body.id,
    filename: body.filename,
    displayName: body.displayName ?? null,
    fileSize: body.fileSize ?? null,
    contentType: body.contentType ?? null,
    status: body.status ?? null,
    folderId: null,
    createdAt:
      typeof body.createdAt === 'string'
        ? body.createdAt
        : (body.createdAt?.toISOString() ?? new Date().toISOString()),
    errorMessage: body.errorMessage ?? null,
    summary: body.summary ?? null,
    pageCount: body.pageCount ?? null,
    chunkCount: body.chunkCount ?? null,
    contentTypes: body.contentTypes ?? null,
    tags: body.tags ?? null,
  }
}
