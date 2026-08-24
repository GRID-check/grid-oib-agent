/** Org-wide Archiv: the top-level, cross-project document store (ADR-0024). */
export const archiv = {
  title: 'Archiv',
  subtitle: 'Shared documents available to every project in your organization',
  backToApp: 'Back to projects',
  backToProject: 'Back to project',
  backToNamedProject: 'Back to {name}',
  library: {
    searchPlaceholder: 'Search the Archiv…',
    searchLabel: 'Search Archiv documents',
    resetSearch: 'Reset search',
    categoriesLabel: 'Filter by category',
    allCategories: 'All',
    emptyTitle: 'The Archiv is empty',
    emptyDescription:
      'Documents stored here become office knowledge, available to every project in your organization.',
    noMatchTitle: 'No matching documents',
    noMatchDescription: 'No Archiv document matches your search or the selected category.',
    clearFilters: 'Clear filters',
    provenance: 'From: {source}',
    semantic: {
      searchPlaceholder: 'Search the Archiv — press Enter for semantic search…',
      run: 'Search',
      reset: 'Show all documents',
      banner: 'Semantic search: {count, plural, one {# result} other {# results}} for “{query}”',
      searching: 'Searching the Archiv for “{query}”…',
      noResults: 'No semantic matches for “{query}”',
      /** A search that could not RUN — see the same pair in `files`. */
      failed: 'The search could not be run',
      failedDescription:
        'Something went wrong on the way to the index. The Archiv is untouched — try the same search again, or go back to all documents.',
      retry: 'Try again',
      failedBanner: 'Semantic search for “{query}” could not be run',
      noResultsDescription:
        'Nothing in the Archiv matched the meaning of your query. Try different wording, or clear the search to browse every document.',
    },
    kind: {
      floorplan: 'Floor plan',
      section: 'Section',
      siteplan: 'Site plan',
      notice: 'Notice',
      photo: 'Photo',
      document: 'Document',
    },
  },
  toast: {
    // Fired the instant async ingestion finishes and the document becomes
    // citable across every project in the organization.
    ingestionComplete: '“{name}” is now in the office Archiv — citable',
  },
  workspace: {
    dropToUpload: 'Drop files to add them to the Archiv',
    dropUnsupported: 'Some files are not a supported type',
    uploadProblem: 'Upload problem',
    dismissError: 'Dismiss error',
    loadError: 'The Archiv could not be loaded.',
    tryAgain: 'Try again',
  },
  actions: {
    label: 'File actions for “{name}”',
    reingest: 'Retry indexing',
    reingesting: 'Retrying…',
    reingestError: 'Indexing could not be restarted. Please try again.',
    menuLabel: 'File actions',
    download: 'Download',
    rename: 'Rename…',
    delete: 'Delete…',
  },
  rename: {
    title: 'Rename document',
    description:
      'Changes the name shown everywhere in Grid, including on citations. The file itself and everything indexed from it stay as they are.',
    label: 'Name',
    hint: 'The file extension stays as it is.',
    save: 'Rename',
    saving: 'Saving…',
    cancel: 'Cancel',
    restore: 'Restore original name',
    success: 'Now called “{name}”',
    restored: 'Back to “{name}”',
    error: 'The document could not be renamed',
    errors: {
      empty: 'Please enter a name.',
      tooLong: 'That name is too long.',
      invalidCharacters: 'A name cannot contain slashes or line breaks.',
    },
  },
  delete: {
    action: 'Delete from Archiv',
    title: 'Delete “{name}”?',
    confirm: 'This removes the document for the whole organization. This cannot be undone.',
    confirmAction: 'Delete',
    cancel: 'Cancel',
    deleting: 'Deleting…',
    success: '“{name}” was removed from the Archiv',
    error: 'The document could not be deleted',
  },
}
