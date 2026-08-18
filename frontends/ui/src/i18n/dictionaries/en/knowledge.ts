/** Knowledge-base transparency page: what the RAG currently knows. */
export const knowledge = {
  title: 'Knowledge base',
  subtitle:
    'Every document the assistant can ground its answers in — the shared OIB Richtlinien plus the files uploaded to this project. Nothing else is used.',
  summary: {
    documents: 'Documents',
    indexed: 'Indexed',
    chunks: 'Searchable sections',
    attention: 'Needs attention',
    lastUpdated: 'Index last updated {date}',
  },
  corpus: {
    title: 'Shared OIB Richtlinien',
    description:
      'The Austrian OIB guidelines every project shares. Documents marked "Indexed" are fully searchable by the assistant.',
    empty: 'No Richtlinien documents were found. The initial processing may still be running.',
    notSynced: 'The knowledge base has not been built yet. Documents appear here once the first processing run finishes.',
    columns: {
      document: 'Document',
      status: 'Status',
      chunks: 'Sections',
      size: 'Size',
      ingestedAt: 'Indexed on',
    },
    chunkCount: '{count} sections',
    checksum: 'SHA-256 checksum: {hash}',
  },
  project: {
    title: 'Project documents',
    description:
      'Files uploaded to this project. Once processing finishes they are searchable in this project’s chats alongside the shared Richtlinien.',
    empty: 'No project documents yet. Files you upload under “Files” become part of the assistant’s knowledge.',
    goToFiles: 'Manage files',
  },
  states: {
    ingested: 'Indexed',
    stale: 'Outdated',
    pending: 'Not indexed yet',
    snapshot: 'Indexed (no original)',
    removed: 'Source removed',
    inconsistent: 'Index missing',
  },
  stateHints: {
    ingested: 'Fully searchable by the assistant.',
    stale: 'The file changed on disk since it was indexed; answers still reflect the previous version until the next sync.',
    pending: 'Uploaded but not processed yet — the assistant cannot use it until the next sync completes.',
    snapshot: 'Taken from a prepared set; fully searchable, but the source PDF is not stored on this server.',
    removed: 'The source file was removed; indexed content may still be retrievable until cleanup.',
    inconsistent: 'Recorded as processed but no searchable content was found. Re-run the sync.',
  },
  origin: {
    uploaded: 'Uploaded',
  },
  viewer: {
    view: 'View PDF',
    description: 'Original source document.',
    openInTab: 'Open in new tab',
    loading: 'Loading document…',
    pageCount: '{count} pages',
    toPassage: 'Go to passage',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    highlightUnavailable:
      'The passage cannot be marked in this browser — showing the document without the highlight.',
  },
  error: {
    title: 'Knowledge base unavailable',
    description: 'The knowledge status could not be loaded.',
    retry: 'Try again',
  },
  loading: 'Loading knowledge base…',
}
