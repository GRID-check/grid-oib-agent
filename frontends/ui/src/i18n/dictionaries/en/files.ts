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
  // The upload tray. Wording follows the surface's one rule: a number is
  // stated only where one was measured. "Reading" is what the backend does to a
  // document, and it has no ETA — so the copy says so instead of implying one.
  uploads: {
    region: 'Uploads',
    heading: {
      transferringOne: 'Uploading 1 document',
      transferringOther: 'Uploading {count} documents',
      processingOne: 'Piloti is reading 1 document',
      processingOther: 'Piloti is reading {count} documents',
      doneOne: '1 document added',
      doneOther: '{count} documents added',
      mixed: '{ready} added · {failed} failed',
      failedOne: '1 document could not be added',
      failedOther: '{count} documents could not be added',
      canceled: 'Upload canceled',
    },
    detail: {
      bytes: '{done} of {total}',
      eta: '{time} left',
      queued: '{count} waiting',
      // Deliberately not a percentage: indexing progress is reported by the
      // backend in bursts, so any bar drawn from it stalls and then jumps.
      processing: 'Indexing — no time estimate, you can keep working',
      elapsed: '{time} so far',
      settled: '{total} transferred',
    },
    row: {
      queued: 'Waiting',
      uploading: 'Sending',
      processing: 'Reading',
      ready: 'Citable',
      canceled: 'Canceled',
      failed: 'Failed',
    },
    actions: {
      expand: 'Show files',
      collapse: 'Hide files',
      cancelAll: 'Cancel all',
      cancel: 'Cancel upload of {name}',
      retryAll: 'Retry failed',
      dismiss: 'Dismiss {name}',
      dismissAll: 'Dismiss',
    },
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
    modelReady: '“{name}” has been read — you can now ask about the building',
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
    // Heading for the rail's fact list (what the FILE is), distinct from
    // "Detailed information" below it (what the VLM saw on each page).
    properties: 'Properties',
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
      list: 'List',
      tree: 'Folders',
    },
  },
  // Explorer detail view — column headings for the sortable listing.
  list: {
    columns: {
      name: 'Name',
      status: 'Status',
      pages: 'Pages',
      size: 'Size',
      added: 'Added',
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
    someUploadsFailed: '{failed} of {total} documents could not be uploaded. First reason: {reason}',
    uploadingSkipped: 'Uploading {uploading} {fileLabel}, skipped {skipped} ({summary})',
    cannotRetryServerFile: 'Cannot retry server-loaded files. Please upload the file again.',
    imageVlmUnavailable: 'Image upload requires a configured vision model (VLM) on this deployment.',
    fileSingular: 'file',
    filePlural: 'files',
  },
}
