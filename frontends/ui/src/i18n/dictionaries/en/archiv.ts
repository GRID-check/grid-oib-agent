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
      banner: 'Semantic search: {count} results for “{query}”',
      searching: 'Searching the Archiv for “{query}”…',
      noResults: 'No semantic matches for “{query}”',
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
  delete: {
    action: 'Delete from Archiv',
    confirm: 'This removes the document for the whole organization. This cannot be undone.',
    confirmAction: 'Delete',
    cancel: 'Cancel',
    deleting: 'Deleting…',
    success: '“{name}” was removed from the Archiv',
    error: 'The document could not be deleted',
  },
}
