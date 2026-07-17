/** Org-wide Archiv: the top-level, cross-project document store (ADR-0024). */
export const archiv = {
  title: 'Archiv',
  subtitle: 'Shared documents available to every project in your organization',
  backToApp: 'Back to projects',
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
