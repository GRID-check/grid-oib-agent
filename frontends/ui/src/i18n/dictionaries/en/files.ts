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
    // A report Piloti wrote: the file is in the project but deliberately not in
    // the knowledge base. Neither a success ("Citable" would promise a citation
    // retrieval cannot make) nor a failure — nothing went wrong.
    stored: 'Filed',
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
    /**
     * Not a failure to retry: the service answers 404 both for a deleted
     * document and for one this reader may no longer open, and neither changes
     * by asking again. Said plainly, with the only move that is left.
     */
    gone: 'This document is no longer available. It may have been deleted, or you may no longer have access to it.',
    goneAction: 'Stop asking about it',
    goneCleared: 'No longer asking about that file.',
    goneUndo: 'Undo',
    tryAgain: 'Try again',
    noInlinePreview: 'No inline preview for this file type. Download it to view the full document.',
    textTruncated:
      'Only the beginning of this file is shown. Download it to read the whole thing.',
    status: 'Status',
    // Heading for the rail's fact list (what the FILE is), distinct from
    // "Detailed information" below it (what the VLM saw on each page).
    properties: 'Properties',
    summaryMore: 'Show full summary',
    summaryLess: 'Show less',
    type: 'Type',
    size: 'Size',
    originPath: 'Came from',
    originPathCopied: 'Path copied',
    originPathCopyFailed: "Path couldn't be copied",
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
      structured: {
        toggle: 'Structured data',
        composition: 'Build-up {component}',
        states: 'Existing / new',
        relations: 'Relations',
        annotations: 'Annotations',
        project: 'Project',
        credits: 'Details',
        slogans: 'Headlines',
        strategies: 'Strategies',
        processSteps: 'Process',
        provenance: 'Source',
        confidenceValue: 'confidence {level}',
        // Vocabulary terms. A domain added on the backend brings keys that are
        // not here yet; the UI humanizes those from the key, so this list is a
        // courtesy for the domains we ship, never a gate on new ones.
        categories: {
          space: 'Spaces and uses',
          circulation: 'Circulation',
          structure: 'Structure',
          envelope: 'Envelope',
          services: 'Building services',
          building_physics: 'Building physics',
          finish: 'Finishes',
          landscape: 'Outdoor space',
          material: 'Materials',
          object: 'Objects',
          part: 'Parts',
          person: 'People and roles',
          place: 'Places',
          other: 'Other',
        },
        state: {
          existing: 'existing',
          new: 'new',
          demolished: 'demolished',
          reused: 'reused',
          transformed: 'transformed',
        },
        source: {
          text: 'labelled text',
          visual: 'read from the drawing',
          inferred: 'inferred',
        },
        confidence: {
          high: 'high',
          medium: 'medium',
          low: 'low',
        },
      },
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
    /**
     * The seam between the conversation and the file. It is a tab stop (the
     * panel library makes every separator one), so it needs a name — an
     * unlabelled separator is announced as nothing at all.
     */
    resizePeek: 'Resize file preview',
    /**
     * The CONSEQUENCE of the status badge beside them in the chat peek. The
     * badge already says what the state is ("Processing", "Failed"); repeating
     * that in the sentence would spend the one line on the half the reader can
     * already see. What it cannot see is what the state costs: the answer it is
     * about to ask for will not use this file.
     */
    peekIndexingHint: 'Piloti cannot cite this file until it is indexed.',
    peekFailedHint: 'Indexing failed — Piloti cannot cite this file.',
    /** The way out of that: the enlarged view carries the error and the retry. */
    peekFailedAction: 'Details',
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
    clearFilters: 'Clear filters',
    resetSearch: 'Reset search',
    recentlyUploaded: 'Recently uploaded',
    semantic: {
      searchPlaceholder: 'Search files — press Enter for semantic search…',
      run: 'Search',
      reset: 'Show all files',
      noResults: 'No semantic matches for “{query}”',
      /**
       * A search that could not RUN, held apart from one that ran and found
       * nothing. The hook fails open to an empty result set — which is right,
       * it must not crash the pane — and the pane used to render that as "no
       * matches", telling the reader something about their own corpus that the
       * app had no way of knowing.
       */
      failed: 'The search could not be run',
      failedDescription:
        'Something went wrong on the way to the index. Your files are untouched — try the same search again, or go back to all of them.',
      retry: 'Try again',
      noResultsDescription:
        'Nothing in this project matched the meaning of your query. Try different wording, or clear the search to browse every file.',
      page: 'Page {page}',
      relevance: '{percent}% relevance',
    },
  },
  folders: {
    rename: 'Rename…',
    renameLabel: 'Rename folder “{name}”',
    renaming: 'Renaming…',
    delete: 'Delete…',
    actions: 'Folder actions',
    actionsFor: 'Actions for folder “{name}”',
    heading: 'Folders',
    namePlaceholder: 'Folder name',
    newFolderName: 'New folder name',
    creating: 'Creating folder…',
    allFiles: 'All Files',
    // The way up, named. The breadcrumb says where you ARE, which is a map,
    // and three levels deep the parent is a truncated word mid-row.
    backTo: 'Back to {name}',
    newFolder: 'New folder',
    items: '{count} item(s)',
    openFolder: 'Open folder “{name}”',
    breadcrumb: 'Folder path',
  },
  workspace: {
    renameFolderError: 'The folder could not be renamed. Please try again.',
    deleteFolderError: 'The folder could not be deleted. Please try again.',
    deleteFolderConfirm: 'Delete the folder “{name}”?',
    deleteFolderConfirmWithContents:
      'Delete the folder “{name}”?\n\nIts {documents} document(s) and {folders} subfolder(s) are not deleted — they move to “{parent}”.',
    deleteFolderDone: '“{name}” deleted.',
    deleteFolderMoved: 'Folder deleted. {count} document(s) moved to “{parent}”.',
    corpusSubtitle: 'Project knowledge — these documents ground Piloti’s answers',
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
    },
  },
  // Explorer detail view — column headings for the sortable listing.
  list: {
    columns: {
      relevance: 'Relevance',
      name: 'Name',
      status: 'Status',
      pages: 'Pages',
      size: 'Size',
      added: 'Added',
    },
  },
  // The overflow menu every document surface carries.
  actions: {
    reingest: 'Retry indexing',
    move: 'Move to folder',
    moved: '“{name}” moved to {folder}',
    moveError: 'The document could not be moved. Please try again.',
    reingesting: 'Retrying…',
    reingestError: 'Indexing could not be restarted. Please try again.',
    label: 'File actions for “{name}”',
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
    action: 'Delete document',
    title: 'Delete “{name}”?',
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
    uploadFolder: 'Upload folder',
    uploadFiles: 'Choose files',
  },
  errors: {
    validation: {
      duplicateInBatch: '“{name}” is in this selection more than once',
      duplicateExisting: '“{name}” has already been added',
      invalidType: '“{name}” is not a supported file type. Accepted: {accepted}',
      fileTooLarge: '“{name}” is {size} — the limit is {limit}',
      totalSizeExceeded:
        'That would come to {total}; only {available} of the {limit} limit is free',
      totalSizeExceededFirst: '{total} is over the {limit} limit',
      maxFilesExceeded: 'That would be {total} files; only {available} more fit ({limit} maximum)',
      maxFilesExceededFirst: '{total} files is over the limit of {limit}',
      several: '{count} files have issues',
    },
    someUploadsFailed:
      '{failed} of {total} documents could not be uploaded. First reason: {reason}',
    uploadingSkipped: 'Uploading {uploading} {fileLabel}, skipped {skipped} ({summary})',
    cannotRetryServerFile: 'Cannot retry server-loaded files. Please upload the file again.',
    imageVlmUnavailable:
      'Images cannot be uploaded here: this deployment has no image recognition set up.',
    fileSingular: 'file',
    filePlural: 'files',
  },
  /**
   * Provenance — who wrote the bytes. Deliberately its own group and NOT part
   * of `assignment`: a face says who is responsible for a file, this says who
   * made it, and the file-native design is explicit that provenance is never
   * rendered as responsibility. A generated report is an ordinary UNASSIGNED
   * file, so the footer still says `Unassigned` beside this line.
   */
  /**
   * The Files header's filter/sort menu.
   *
   * Replaces the open filter strip: the header already carried a view switch, a
   * search field and an upload button, and had no room left for the filters
   * people asked for. The count on the button is the price of hiding them — a
   * filter nobody can see is worse than a crowded strip.
   */
  filters: {
    label: 'Filter',
    labelActive: 'Filters ({count} active)',
    reset: 'Reset filters',
    // What the reader is missing when type or status emptied the level: the
    // fact that a filter, and not an empty folder, is the reason.
    emptyTitle: 'No file matches these filters',
    emptyDescription:
      'This folder holds documents, but none matches the current selection. Reset the filters to see everything again.',
    sortLabel: 'Sort',
    ascending: 'Ascending',
    descending: 'Descending',
    statusLabel: 'Status',
    // The three questions actually asked, not the ten pipeline states that
    // differ only in which stage reported them.
    status: {
      failed: 'Failed',
      processing: 'In progress',
      ready: 'Citable',
    },
    originLabel: 'Origin',
    kindLabel: 'File type',
    kind: {
      floorplan: 'Floor plan',
      section: 'Section / elevation',
      siteplan: 'Site plan',
      notice: 'Official notice',
      photo: 'Photo',
      model: '3D model (IFC)',
      document: 'Document',
    },
  },
  authorship: {
    byPiloti: 'Created by Piloti',
    /** Filter chip beside All · Mine · Unassigned. */
    filter: 'By Piloti',
    /** The question this filter left unanswered: WHICH files those would be. */
    emptyTitle: 'Piloti has filed nothing here yet',
    emptyDescription:
      'This is where the files Piloti wrote itself appear: filed research reports and diagrams. Documents you uploaded do not count, even where Piloti has read them.',
    /**
     * Why Ask is disabled on a generated report — and it is disabled, not
     * hidden, following the pattern the citable-yet case already set. The
     * difference is that there is no "yet": the report was never indexed, on
     * purpose, so that the agent cannot cite its own writing back as evidence.
     */
    notInKnowledge: 'Created by Piloti — not in the knowledge base',
  },
  assignment: {
    unassigned: 'Unassigned',
    assign: 'Assign',
    edit: 'Edit',
    assignToMe: 'Assign to me',
    filterAll: 'All',
    filterMine: 'Mine',
    filterUnassigned: 'Unassigned',
    emptyUnassigned: 'Every file has someone',
    emptyMine: 'Nothing is assigned to you yet',
    emptyDescription:
      'Another filter brings back every file in this folder.',
    responsible: 'Responsible',
    ask: 'Ask Piloti',
    askDisabled: 'Once the file is citable',
    askColleague: 'Ask a colleague',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
    alsoAssign: 'Also assign',
    send: 'Send',
    to: 'To',
    message: 'Message',
    starterKeyPoints: 'What are the key points?',
    starterOib: 'Which OIB provisions apply here?',
    starterKeyPointsNamed: 'What are the key points in “{name}”?',
    starterOibNamed: 'Which OIB provisions apply to “{name}”?',
    askingAbout: 'Asking about {name}',
    askingAboutPrefix: 'Asking about',
    thisFile: 'this file',
    showFile: 'Show file',
    expandFile: 'Open larger',
    resizeFile: 'Resize file pane',
    welcomeAbout:
      'This thread is about {name}. Ask it something — answers will cite the file and the law.',
    subjectHint:
      'Piloti searches this document. Other project files and the office archive stay out.',
    subjectClear: 'Stop focusing on this file',
    loadingPeople: 'Loading people…',
    noPeople: 'No one in this project yet',
    peopleLoadError: 'Could not load people',
    assignError: '“{name}” could not be made responsible',
    unassignError: '“{name}” could not be removed',
    tryAgain: 'Try again',
  },
}
