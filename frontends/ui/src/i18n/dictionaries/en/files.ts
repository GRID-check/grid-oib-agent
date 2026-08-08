/** files namespace — populated during component i18n. */
export const files = {
  uploadZone: {
    clickToUpload: 'Click to upload',
    orDragAndDrop: ' or drag and drop',
    maxSize: 'Up to {size} MB',
    accepts: 'Accepts: {types}',
    dragOrBrowse: 'Drag files here or browse',
    maxSizeShort: 'max. {size} MB',
  },
  activeUploads: {
    heading: 'Uploads',
    uploadFailed: 'Upload failed',
  },
  status: {
    // "Citable" (not a bare "Ready") answers the one question that matters to a
    // compliance user: the document is now in Piloti's knowledge and can be
    // cited in an answer.
    ready: 'Citable',
    processing: 'Processing',
    uploading: 'Uploading',
    failed: 'Failed',
    unknown: 'Unknown',
  },
  toast: {
    // Fired the instant async ingestion finishes and the document becomes
    // citable — the confirmation the completion moment previously lacked.
    ingestionComplete: '“{name}” is now in Piloti’s knowledge — citable',
  },
  // Card thumbnail fallbacks: a warm placeholder chip when no thumbnail exists,
  // and an honest "couldn't load" label for a genuine failure (never a broken
  // image look). `image` is the generic chip when there is no file extension.
  thumbnail: {
    image: 'Image',
    unavailable: 'Preview unavailable',
  },
  preview: {
    closePreview: 'Close preview',
    expandPreview: 'Open large preview',
    loadFailed: "Preview couldn't be loaded. You can still download the file below.",
    tryAgain: 'Try again',
    noInlinePreview:
      'No inline preview for this file type. Download it to view the full document.',
    status: 'Status',
    type: 'Type',
    size: 'Size',
    tags: 'Tags',
    noTags: 'No tags',
    tagsSaveError: "Tags couldn't be saved. Please try again.",
    addTagPlaceholder: 'Add tag',
    addTagLabel: 'Add tag',
    removeTag: 'Remove tag {tag}',
    suggestionsLabel: 'Tag suggestions',
    noTagMatch: 'No matching tag — pick one of the suggested labels.',
    indexed: {
      title: 'Indexed by Piloti',
      documentType: 'Document type',
      project: 'Project',
      updated: 'Updated',
      caption: 'Automatically detected on upload — your corrections improve future answers.',
    },
    pages: 'Pages',
    chunks: 'Passages',
    contents: 'Contents',
    contentTypeNames: {
      text: 'Text',
      table: 'Tables',
      chart: 'Charts',
      image: 'Images',
      drawing: 'Drawings',
    },
    visualDetails: {
      title: 'Detailed information',
      loading: 'Loading descriptions…',
      empty: 'No visual descriptions available.',
      page: 'Page {page}',
      scale: 'Scale {scale}',
    },
    unknownType: 'Unknown',
    download: 'Download',
    downloadFailed: "The download couldn't be started. Please try again.",
    ingestionFailed: 'Ingestion failed',
    ingestionFailedGeneric: "This document couldn't be processed for search.",
    retryIngestion: 'Retry ingestion',
    retryingIngestion: 'Retrying…',
    retryIngestionError: "Ingestion couldn't be restarted. Please try again.",
    dialogLabel: 'File preview: {name}',
    // Was 'Page 1 of {count}' — hardcoded to page 1, so it stated a falsehood
    // on every page but the first. The pane has no page-tracking (the PDF renders
    // in a native iframe we cannot observe), so it states the count it actually
    // knows rather than a position it does not.
    // Count-neutral: the pane renders this for a one-page document too.
    pageCountOnly: 'Total pages: {count}',
  },
  browser: {
    folderEmptyTitle: 'This folder is empty',
    folderEmptyDescription: 'Upload documents here, or pick another folder from the sidebar.',
    noDocumentsTitle: 'No documents yet',
    noDocumentsDescription:
      "Add your building's plans, permits and reports. Piloti reads them to ground every answer in your project's own documents — not generic guidance.",
    searchPlaceholder: 'Search files...',
    searchLabel: 'Search files',
    noMatch: 'No files match “{query}”',
    noMatchDescription:
      'Try a different name, tag or description, or clear the search to see every file.',
    clearSearch: 'Clear search',
    resetSearch: 'Reset search',
    recentlyUploaded: 'Recently uploaded',
    semantic: {
      searchPlaceholder: 'Search files — press Enter for semantic search…',
      run: 'Search',
      reset: 'Show all files',
      banner: 'Semantic search: {count} results for “{query}”',
      searching: 'Searching the corpus for “{query}”…',
      noResults: 'No semantic matches for “{query}”',
      noResultsDescription:
        'Nothing in this project matched the meaning of your query. Try different wording, or clear the search to browse every file.',
      page: 'Page {page}',
      relevance: '{percent}% relevance',
    },
  },
  folders: {
    heading: 'Folders',
    namePlaceholder: 'Folder name',
    newFolderName: 'New folder name',
    creating: 'Creating folder…',
    addSubfolderIn: 'Add subfolder in {name}',
    addSubfolder: 'Add subfolder',
    allFiles: 'All Files',
    newFolder: 'New folder',
  },
  workspace: {
    corpusSubtitle: 'Project corpus — these documents ground Piloti’s answers',
    uploadDocuments: 'Upload documents',
    uploadProblem: 'Upload problem',
    dismissError: 'Dismiss error',
    createFolderError: 'Could not create folder. Please try again.',
    foldersLoadError: "Folders couldn't be loaded.",
    documentsLoadError: "Documents couldn't be loaded.",
    tryAgain: 'Try again',
    dropToUpload: 'Drop files to upload to this project',
    dropUnsupported: 'Some files are not a supported type',
    view: {
      label: 'View',
      cards: 'Cards',
      tree: 'Folders',
    },
  },
  delete: {
    action: 'Delete document',
    confirm: 'This removes the document from this project. This cannot be undone.',
    confirmAction: 'Delete',
    cancel: 'Cancel',
    deleting: 'Deleting…',
    success: '“{name}” was removed from the project',
    error: 'The document could not be deleted',
  },
  upload: {
    uploading: 'Uploading…',
    upload: 'Upload',
  },
  errors: {
    uploadingSkipped: 'Uploading {uploading} {fileLabel}, skipped {skipped} ({summary})',
    cannotRetryServerFile: 'Cannot retry server-loaded files. Please upload the file again.',
    imageVlmUnavailable: 'Image upload requires a configured vision model (VLM) on this deployment.',
    fileSingular: 'file',
    filePlural: 'files',
  },
}
