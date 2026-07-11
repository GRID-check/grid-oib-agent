/** Knowledge-base transparency page: what the RAG currently knows. */
export const knowledge = {
  title: 'Knowledge base',
  subtitle:
    'Every document the assistant can ground its answers in — the shared OIB Richtlinien corpus plus the files uploaded to this project. Nothing else is used.',
  summary: {
    documents: 'Documents',
    indexed: 'Indexed',
    chunks: 'Searchable chunks',
    attention: 'Needs attention',
    lastUpdated: 'Index last updated {date}',
  },
  corpus: {
    title: 'OIB Richtlinien corpus',
    description:
      'The Austrian OIB guidelines every project shares. Documents marked "Indexed" are fully searchable by the assistant.',
    empty: 'No corpus documents were found. The initial ingestion may still be running.',
    notSynced: 'The knowledge index has not been built yet. Documents appear here once the first ingestion finishes.',
    columns: {
      document: 'Document',
      status: 'Status',
      chunks: 'Chunks',
      size: 'Size',
      ingestedAt: 'Indexed on',
    },
    chunkCount: '{count} chunks',
    checksum: 'SHA-256 checksum: {hash}',
  },
  project: {
    title: 'Project documents',
    description:
      'Files uploaded to this project. Once processing finishes they are searchable in this project’s chats alongside the shared corpus.',
    empty: 'No project documents yet. Files you upload under “Files” become part of the assistant’s knowledge.',
    goToFiles: 'Manage files',
  },
  states: {
    ingested: 'Indexed',
    stale: 'Outdated',
    pending: 'Not indexed yet',
    removed: 'Source removed',
    inconsistent: 'Index missing',
  },
  stateHints: {
    ingested: 'Fully searchable by the assistant.',
    stale: 'The file changed on disk since it was indexed; answers still reflect the previous version until the next sync.',
    pending: 'On disk but not ingested yet — the assistant cannot use it until the next sync completes.',
    removed: 'The source file was removed; indexed content may still be retrievable until cleanup.',
    inconsistent: 'Recorded as ingested but no indexed content was found. Re-run the sync.',
  },
  error: {
    title: 'Knowledge base unavailable',
    description: 'The knowledge status could not be loaded from the backend.',
    retry: 'Try again',
  },
  loading: 'Loading knowledge base…',
}
