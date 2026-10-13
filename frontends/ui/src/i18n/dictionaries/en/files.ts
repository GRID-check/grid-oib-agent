/** files namespace — populated during component i18n. */
export const files = {
  uploadZone: {
    clickToUpload: 'Click to upload',
    orDragAndDrop: ' or drag and drop',
    /** `size` is formatted with its unit ("100 MB"); the limit is per file. */
    maxSize: 'Up to {size} per file',
    accepts: 'Accepts: {types}',
    dragOrBrowse: 'Drag files here or browse',
    maxSizeShort: 'max. {size} per file',
  },
  // The upload tray. Wording follows the surface's one rule: a number is
  // stated only where one was measured. "Reading" is what the backend does to a
  // document, and it has no ETA — so the copy says so instead of implying one.
  uploads: {
    region: 'Uploads',
    // Not an error and nothing to retry: the document is still being read,
    // the tray has only stopped following it every few seconds.
    stillReading: 'Reading is taking longer than usual and continues in the background.',
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
      // Held back by the content check (ADR-0086): not a failure, nothing to
      // retry. Never "release", which collides with approving a revision.
      heldOne: '1 document held back',
      heldOther: '{count} documents held back',
      mixedHeld: '{ready} added · {held} held back',
      canceled: 'Upload canceled',
    },
    detail: {
      bytes: '{done} of {total}',
      eta: '{time} left',
      queued: '{count} waiting',
      // Deliberately not a percentage: reading progress is reported by the
      // backend in bursts, so any bar drawn from it stalls and then jumps.
      processing: 'Reading. There is no time estimate, so you can keep working.',
      elapsed: '{time} so far',
      settled: '{total} transferred',
    },
    row: {
      queued: 'Waiting',
      uploading: 'Sending',
      processing: 'Reading',
      ready: 'Citable',
      unchanged: 'Unchanged – already here',
      // The content check matched; what it found is listed beneath the row.
      held: 'Held back',
      // Kept, never read: neither a success nor a failure (as `status.stored`).
      stored: 'Filed',
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
    processing: 'Reading',
    uploading: 'Uploading',
    failed: 'Failed',
    // A report Piloti wrote: the file is in the project but deliberately not in
    // the knowledge base. Neither a success ("Citable" would promise a citation
    // retrieval cannot make) nor a failure — nothing went wrong.
    stored: 'Filed',
    // The content check (ADR-0086) matched: the file is in the project, no
    // model has seen it, and someone has to decide.
    quarantined: 'Quarantined',
    unknown: 'Unknown',
    // Only the office's own uploads: inside one office the queue reads in
    // order, across offices it takes turns (ADR-0076).
    queuedAhead: '{count, plural, one {Waiting · # file ahead} other {Waiting · # files ahead}}',
  },
  toast: {
    // Fired the instant async ingestion finishes and the document becomes
    // citable — the confirmation the completion moment previously lacked.
    ingestionComplete: '“{name}” is now in Piloti’s knowledge — citable',
    modelReady: '“{name}” has been read. You can now ask about the building.',
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
    // An office file is shown through a PDF the BFF makes from it (ADR-0070).
    renditionPending: 'Creating PDF preview…',
    renditionNote: 'PDF preview · Original: {name}',
    noInlinePreview: 'No inline preview for this file type. Download the file to view the full document.',
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
    reading: {
      classifiedAs: 'Piloti reads this as',
      noType: 'Piloti did not recognize a document type.',
      correct: 'Correct',
      assign: 'Assign',
      done: 'Done',
      correctionKept: 'Your choice stays, even when Piloti reads the file again.',
      topics: 'Topics',
      addTopic: 'Add topic',
      topicsSaveError: 'The topics could not be saved.',
      capturedAt: 'Taken on {when}',
      location: 'Location',
    },
    /** Where the document stands among its Fassungen (document-fassungen.tsx). Never „plan“: a name does not say what a file is. */
    fassung: {
      unlink: 'Remove link',
      timeline: 'All revisions of this document',
      current: 'current',
      open: 'Open',
      compare: 'Compare',
      changedSince: 'What changed since {name}:',
      changedSincePrevious: 'What changed since the previous revision:',
      changeHint: 'Summarized by Piloti from both revisions. Check dimensions and values in the document itself.',
      suggestion: 'Is this a newer revision of {name}?',
      basisTitleBlock: 'The drawing number and index in the title block suggest so.',
      basisName: 'The index and date in the file name suggest so.',
      basisContent: 'Piloti read both:',
      confirm: 'Yes, newer revision',
      dismiss: 'No',
      askEditor: 'Anyone who may edit this folder can confirm it.',
      saveError: 'The link could not be saved. Please try again.',
      versions: {
        open: 'Open',
        download: 'Download',
        compareText: 'Compare text with revision {number}',
      },
      /** The section in the rail (document-fassungen.tsx). Revisions are numbered newest first, across same-name uploads and linked documents; the header says where the NEWEST stands. */
      rail: {
        number: 'Revision {number}',
        dateTag: 'as of {date}',
        stepOf: 'Step {step} of {total}: {stage}',
        next: {
          approve: 'Next step: approval by {who}',
          approveYou: 'Next step: your approval',
          approveOpen: 'Next step: approval',
          revise: 'Next step: rework by {who}',
          reviseYou: 'Next step: your rework',
          submit: 'Next step: submission for approval by {who}',
          submitYou: 'Next step: submit it for approval',
          publish: 'Next step: publication',
          publishYou: 'Next step: publish it',
        },
        whoMore: '{names} or {count} others',
        /** Only when the name is truly unknown. Never “someone”. */
        someone: 'a team member',
        answer: {
          this: 'Piloti answers from this revision.',
          older: 'Piloti still answers from revision {number}.',
          newer: 'Piloti answers from the newer revision {number}; this one stays readable, also for comparing.',
          notYet: 'Piloti answers from it only once it is published.',
          never: 'Piloti does not answer from it.',
        },
        /** {name} arrives with the date: “Anna Berger · 14 Aug 2026”, kept on one line. */
        act: '{act} by {name}',
        actAnonymous: '{act} on {date}',
        byYou: 'you',
        bySomeone: 'a team member',
        rowMenu: 'More actions for revision {number}',
        approveExplain:
          'Approving means the office stands behind the content. It can then be published; only then does Piloti answer from it.',
        changedSince: 'Changed since revision {number}:',
        archive: 'Retire this file …',
      },
    },
    indexed: {
      title: 'Read by Piloti',
      documentType: 'Document type',
      project: 'Project',
      updated: 'Updated',
      pending: 'Piloti is still reading this document – its summary and properties appear here once it is done.',
    },
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
      failed: 'The descriptions could not be loaded.',
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
          text: 'labeled text',
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
    // The Type row names the format, never the MIME type (that is the tooltip).
    formats: {
      pdf: 'PDF',
      word: 'Word document',
      excel: 'Excel spreadsheet',
      powerpoint: 'PowerPoint presentation',
      odText: 'OpenDocument text',
      odSpreadsheet: 'OpenDocument spreadsheet',
      odPresentation: 'OpenDocument presentation',
      rtf: 'Rich Text document',
      csv: 'CSV table',
      tsv: 'TSV table',
      markdown: 'Markdown',
      plainText: 'Text file',
      ifc: 'IFC model',
      email: 'Email',
      image: 'Image ({format})',
      extension: '{ext} file',
      raw: '{type}',
    },
    download: 'Download',
    downloadFailed: "The download couldn't be started. Please try again.",
    ingestionFailed: 'Reading failed',
    heldTitle: 'Held back by the content check',
    heldDecided: 'Someone has already decided about this file.',
    ingestionFailedPreviousVersionKept:
      'Search and Piloti still use the previous revision. The download serves the new file.',
    retryIngestion: 'Read again',
    retryWouldFailAgain: 'Reading this file again would give the same result. Upload a new revision instead.',
    retryingIngestion: 'Retrying…',
    retryIngestionError: "Reading couldn't be restarted. Please try again.",
    dialogLabel: 'File preview: {name}',
    /**
     * The seam between the conversation and the file. It is a tab stop (the
     * panel library makes every separator one), so it needs a name — an
     * unlabelled separator is announced as nothing at all.
     */
    resizePeek: 'Resize file preview',
    /**
     * The CONSEQUENCE of the status badge beside them in the chat peek. The
     * badge already says what the state is ("Reading", "Failed"); repeating
     * that in the sentence would spend the one line on the half the reader can
     * already see. What it cannot see is what the state costs: the answer it is
     * about to ask for will not use this file.
     */
    peekIndexingHint: 'Piloti cannot cite this file until it has been read.',
    peekFailedHint: 'Reading failed. Piloti cannot cite this file.',
    /**
     * The same failure on a document with an earlier revision: the index keeps
     * that revision's passages, so the file is still citable, just not the new
     * bytes. Mirrors `ingestionFailedPreviousVersionKept` in the pane.
     */
    peekFailedPreviousVersionHint:
      'The new file could not be read — Piloti is still citing the previous revision.',
    /** The way out of that: the enlarged view carries the error and the retry. */
    peekFailedAction: 'Details',
  },
  /**
   * Why a document could not be read, by the category
   * `features/documents/lib/ingest-failure.ts` gives the stored error. The raw
   * text stays behind `details`.
   */
  ingestFailure: {
    rendition_failed: "The PDF preview of this file couldn't be created. Try reading it again, or upload it as a PDF.",
    download_failed: "The uploaded file couldn't be fetched from storage. Try reading it again, or upload it once more.",
    interrupted: 'Reading stopped when the service restarted. Read it again to finish.',
    unreadable_pages:
      "{failed} of {total} pages couldn't be read. Try reading it again. If that fails too, the PDF is probably damaged.",
    vision_not_configured:
      'Scanned pages and images need a vision model, and none is set up. Ask your admins to configure one.',
    dispatch_failed: "Reading couldn't be started. Try again.",
    timeout: 'Reading took too long and was stopped. Try again. Splitting a very large file helps.',
    empty: 'No text was found in this file. It may be password-protected, damaged or empty.',
    deleted: 'The file was deleted while Piloti was reading it.',
    quarantined:
      'This file contains something your office marks as sensitive. Piloti showed it to no model. An office or project admin reviews it and decides whether it stays or is deleted.',
    unknown: "Piloti couldn't read this document, so search can't find it.",
    details: 'Details',
  },
  screening: {
    // Why a file was held back, by the content check (in the text) or the
    // name check (in the file or folder name), ADR-0086.
    reasonTerm: '“{term}” in the text',
    reasonIban: 'IBAN {sample}',
    reasonSvnr: 'Social security number {sample}',
    reasonCard: 'Card number {sample}',
    reasonPages: '{count, plural, one {page {pages}} other {pages {pages}}}',
    nameInFile: 'File name contains “{term}”',
    nameInFolder: 'Folder “{segment}” contains “{term}”',
    partial: 'Some pages had no text layer and were not checked.',
    unchecked: 'The content could not be read without a model and was checked by name only.',
    // A content-check finding, the way a chat source is shown: the page, and on
    // it, marked, what the office listed as sensitive.
    findingsLabel: 'Where the content check found it',
    findingPage: 'p. {page}',
    showFinding: 'Show the finding on page {page}',
    morePages: 'Found on further pages too',
  },
  browser: {
    folderEmptyTitle: 'This folder is empty',
    folderEmptyDescription: 'Upload documents here, or pick another folder from the sidebar.',
    noDocumentsTitle: 'No documents yet',
    noDocumentsDescription:
      'Upload your project’s documents: drawings, official notices, expert reports. Piloti reads them and cites them instead of answering from generic guidance.',
    searchPlaceholder: 'Search files...',
    searchLabel: 'Search files',
    noMatch: 'No files match “{query}”',
    noMatchDescription:
      'Try a different name, tag or description, or clear the search to see every file.',
    clearSearch: 'Clear search',
    clearFilters: 'Clear filters',
    resetSearch: 'Reset search',
    recentlyUploaded: 'Recently uploaded',
    /** Empty search when the search matches names only (the folder loads page by page, ADR-0102). */
    noMatchNamesDescription:
      'The search looks at file names. Press Enter to search the contents too, or clear the search to see every file.',
    /** The end of a large folder's list: the rest arrives as you scroll. */
    loadMore: 'Load more',
    loadingMore: 'Loading more documents…',
    loadMoreFailed: 'More documents could not be loaded.',
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
    newInside: 'New folder inside',
    open: 'Open',
    move: 'Move to folder',
    items: '{count, plural, one {# item} other {# items}}',
    openFolder: 'Open folder “{name}”',
    breadcrumb: 'Folder path',
    movedFolder: '“{name}” moved to “{parent}”.',
    moveFolderError: 'The folder could not be moved. Please try again.',
    /** Folder access (ADR-0088, ADR-0097): restricting a folder to people. */
    access: {
      menu: 'Access…',
      /** The lock on a folder: who is on the list only the dialog says. */
      ownList: 'Own access: only the listed people',
      ownListEveryoneReads: 'Own access: all project members read, only the listed people edit',
      openRestricted: 'Open folder “{name}”. {access}',
      title: 'Access to “{name}”',
      description: 'Who in this project may read and edit this folder, its subfolders and their documents.',
      inherit: 'Same as the parent folder',
      inheritHint:
        'The folder takes the access of the folder above it. At the top, the project applies: whoever may read reads, whoever may edit edits.',
      custom: 'Custom access',
      customHint:
        'Only the listed people get into the folder, each with “Read” or “Edit”. Anyone not listed does not see it, unless all project members may read. Organization admins may always do everything.',
      everyoneReads: 'All project members may read',
      everyoneReadsHint: 'The list then decides only who may edit.',
      people: 'People',
      unknownPerson: 'Person without project access',
      levelRead: 'Read',
      levelWrite: 'Edit',
      levelFor: 'Access for {name}',
      remove: 'Remove {name}',
      add: 'Add a person…',
      pickOne: 'Add at least one person, or let all project members read.',
      nesting: 'A subfolder can only be narrower than its parent folder, never wider.',
      ceiling: '“Edit” applies only to people who may edit in the project; everyone else reads.',
      lockout:
        'If you are not on the list yourself, the folder disappears for you too once you save, unless you are an organization admin.',
      lockoutEveryoneReads:
        'If you are not on the list with “Edit” yourself, you may only read the folder once you save, unless you are an organization admin.',
      moveNotice:
        'If who may read changes, Piloti moves the folder’s documents and reads them again. For a large folder that takes a few minutes; meanwhile the documents show as “Reading”.',
      ifcNotice:
        'Folders not every project member may read cannot hold building models (IFC) yet. Keep IFC models in folders everyone may read.',
      /** The 409 from the IFC guard (ADR-0087): restricting, uploading or moving into a restricted folder. */
      ifcRefused:
        'Building models (IFC) cannot be filed in a folder not everyone may read yet: their building data is not protected by folder access. Keep IFC models in folders everyone may read.',
      readOnlyBadge: 'Read only',
      readOnlyHint: 'You may read this folder, but not upload, rename, move or delete anything in it.',
      readOnlyMenu: 'Read only',
      readOnlyRefused: 'You may only read in this folder.',
      save: 'Save access',
      saving: 'Saving…',
      loadError: 'The access list could not be loaded.',
      savedCustom: '“{name}” now has its own access.',
      savedInherit: '“{name}” now takes the access of its parent folder.',
      moving: '{count, plural, one {# document is} other {# documents are}} being moved and read again.',
      failed:
        '{count, plural, one {# document} other {# documents}} could not be moved yet. Save again to retry.',
      saveError: 'Access could not be changed. Please try again.',
      forbidden: 'Only project admins can change who may read and edit a folder.',
    },
  },
  /** The Papierkorb of a project (ADR-0088). */
  bin: {
    title: 'Bin',
    subtitle:
      'Deleted folders with their subfolders and documents. Until they are permanently deleted they can be restored with their access.',
    back: 'Back to files',
    empty: 'The bin is empty.',
    emptyHint: 'Deleted folders appear here and can be restored.',
    deletedBy: 'Deleted by {name} on {date}',
    deletedOn: 'Deleted on {date}',
    contents:
      '{documents, plural, one {# document} other {# documents}} · {folders, plural, one {# folder} other {# folders}}',
    purgeOn: 'Permanently deleted on {date}',
    purging: 'Being permanently deleted',
    failed: 'The permanent deletion has stopped. An admin is looking into it.',
    restore: 'Restore',
    restored: '“{name}” is restored. Its documents are being read again.',
    restoredToRoot: '“{name}” is restored at the top of the project, because its parent folder is deleted.',
    restoreNameTaken: 'A folder named “{name}” already exists there. Rename it, then restore again.',
    restoreReadOnly: 'It can be restored by someone who could edit the folder.',
    restoreError: 'The folder could not be restored. Please try again.',
    purge: 'Delete permanently',
    purgeTitle: 'Permanently delete “{name}”?',
    purgeDescription:
      'The folder, its subfolders and {documents, plural, one {# document} other {# documents}} are deleted now, with every revision and preview. This cannot be undone. What Piloti derived from them follows your organization’s setting.',
    purged: '“{name}” is permanently deleted.',
    held: 'This folder is under a retention obligation and cannot be deleted right now.',
    purgeError: 'The folder could not be permanently deleted. Please try again.',
    cancel: 'Cancel',
    loadError: 'The bin could not be loaded.',
    retry: 'Try again',
  },
  workspace: {
    renameFolderError: 'The folder could not be renamed. Please try again.',
    deleteFolderError: 'The folder could not be deleted. Please try again.',
    deleteFolderConfirm: 'Delete the folder “{name}”?',
    deleteFolderConfirmWithContents:
      'Delete the folder “{name}”?\n\nIts {documents} document(s) and {folders} subfolder(s) are not deleted — they move to “{parent}”.',
    deleteFolderDone: '“{name}” deleted.',
    deleteFolderMoved: 'Folder deleted. {count} document(s) moved to “{parent}”.',
    binFolderConfirm:
      'Move the folder “{name}” to the bin?\n\nIts subfolders and documents go with it. From the bin it can be restored with its access until it is permanently deleted.',
    binFolderDone: '“{name}” is in the bin. Restorable until {date}.',
    deleteFolderProtected:
      'This folder holds content you may not delete. It can be deleted by someone who may edit all of its subfolders.',
    deleteFolderIndexDown: 'The folder was not deleted because the search index did not answer. Please try again.',
    openBin: 'Bin',
    corpusSubtitle: 'Project knowledge: documents Piloti reads and cites.',
    uploadDocuments: 'Upload documents',
    uploadProblem: 'Upload problem',
    dismissError: 'Dismiss error',
    createFolderError: 'Could not create folder. Please try again.',
    foldersLoadError: "Folders couldn't be loaded.",
    documentsLoadError: "Documents couldn't be loaded.",
    listTruncated: 'Showing the newest {count} documents. Older ones are missing from this list, from search and filters, and from the folder-upload comparison.',
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
      // The editorial state (Freigabe), beside the ingestion status: the column
      // that makes bulk approval state visible where bulk work happens.
      approval: 'Approval',
      pages: 'Pages',
      size: 'Size',
      added: 'Added',
    },
  },
  // The overflow menu every document surface carries.
  actions: {
    reingest: 'Read again',
    move: 'Move to folder',
    moved: '“{name}” moved to {folder}',
    moveError: 'The document could not be moved. Please try again.',
    reingesting: 'Retrying…',
    reingestRunning: 'Already being read',
    reingestAlreadyDone: 'Already finished',
    reingestWouldFailAgain: 'Reading this file again would give the same result. Upload a new revision instead.',
    reingestConfirmTitle: 'Read “{name}” again?',
    reingestConfirmDescription:
      'Piloti reads the file again from scratch, for example to pick up the pictures in Word and PowerPoint files. Until it is done, Piloti keeps answering from what it read before.',
    reingestConfirmAction: 'Read again',
    reingestError: "Reading couldn't be restarted. Please try again.",
    label: 'File actions for “{name}”',
    menuLabel: 'File actions',
    download: 'Download',
    open: 'Open',
    ask: 'Ask about this',
    copyOriginPath: 'Copy origin path',
    rename: 'Rename…',
    delete: 'Delete…',
  },
  rename: {
    title: 'Rename document',
    description:
      'Changes the name shown everywhere in Piloti, including on citations. The file itself and everything read from it stay as they are.',
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
    legalHold: 'The document is under a legal hold and cannot be deleted',
  },
  /**
   * A ZIP dropped on a shelf. It is unpacked in the browser and then handled as
   * the folder it contains (`folderUpload.*`), so these are only the sentences
   * for an archive that gave nothing.
   */
  zip: {
    reading: 'Reading the ZIP…',
    unreadable: '“{name}” could not be read. Is it a valid ZIP without a password?',
    empty: '“{name}” contains no files.',
    tooManyFiles: '“{name}” contains more than {limit} files, so nothing was taken from it. Split it into smaller ZIPs.',
    tooLarge: '“{name}” unpacks to more than {limit}, so nothing was taken from it. Split it into smaller ZIPs.',
  },
  /**
   * The folder-upload plan — the dialog a dropped directory tree opens before
   * anything moves. `folderUpload.*` rather than under `upload.*` because it
   * describes a PLAN, not the transfer: the words here name what is about to
   * happen to documents that already exist.
   */
  folderUpload: {
    title: 'Upload “{name}”?',
    titleGeneric: 'Upload this folder?',
    // Loose files, at least one of which meets an existing document.
    titleFiles: '{count, plural, one {Upload # file?} other {Upload # files?}}',
    titleFilesGeneric: 'Upload files?',
    destinationFiles: 'The files go into “{folder}”.',
    close: 'Close',
    compareError: 'Could not compare with what is already here. Nothing was uploaded.',
    planChanged: 'The preview has changed. Nothing was uploaded. Please review it and confirm again.',
    single: {
      // One dropped file that is a new revision of a document here, by its name
      // (same name, `update`) or by the name series it continues (`fassung`).
      newFassungTitle: 'New revision of “{name}”?',
      updateExplain:
        '“{name}” is already here under this name. The new file becomes the current revision; the previous one stays readable under “Revisions and approval”.',
      fassungExplain:
        '“{file}” continues “{name}”: the index or date in its name is newer. The older revision stays readable, Piloti answers from the new one and notes what changed; the link can be undone later.',
      unclearTitle: 'Is “{file}” a new revision?',
      unclearExplain:
        'By its name, several documents could be meant. Choose the one this file continues, or upload it as a separate document.',
      notNewerExplain:
        'By its name, “{file}” is not newer than “{name}”. Filed as a new revision, it would still become the current one.',
      unchangedTitle: 'Unchanged – already here',
      unchangedExplain: '“{name}” is identical to this file. Nothing is uploaded.',
      refiled: 'The document is currently in another folder and moves to “{folder}”.',
      archived: 'The document is archived. The new revision is added to it and only shows in the list again once the document is restored.',
      confirmFassung: 'File as a new revision',
      confirmSeparate: 'Upload as a separate document',
    },
    destination: 'Its folder structure is recreated inside “{folder}”.',
    // The re-sync fold: the dropped folder IS the folder they are standing in,
    // so its contents go in rather than a folder of the same name inside it.
    destinationMerged: 'Its contents go straight into “{folder}” — the folders inside it are matched.',
    planning: 'Comparing with what is already here…',
    counts: {
      new: 'new documents',
      update: 'already here, changed',
      unchanged: 'unchanged, skipped',
      foldersCreated: 'folders created',
      foldersMatched: '{count} matched',
    },
    // What the project calls the document a row is about to touch, when
    // somebody has renamed it here and the name in the drop no longer says so.
    alreadyHereAs: 'here as “{name}”',
    archivedMatch: 'archived document',
    refiled:
      '{count, plural, one {# of them is filed elsewhere at the moment and moves to where this folder puts it.} other {# of them are filed elsewhere at the moment and move to where this folder puts them.}}',
    // The unchanged ones send no bytes, so nothing about the upload would move
    // them — they are moved on their own, or the tree is not really recreated.
    moving:
      '{count, plural, one {# unchanged document is filed elsewhere and is moved to where this folder puts it.} other {# unchanged documents are filed elsewhere and are moved to where this folder puts them.}}',
    duplicates:
      '{count, plural, one {# file is already in the project under a different name} other {# files are already in the project under a different name}}',
    duplicatesExplain:
      'Uploading them would add a second copy rather than replace anything, so they are not sent. Rename the document here, or the file on disk, so the two agree.',
    collisions: '{count} files share a name with another file in this upload',
    collisionsExplain:
      'A project holds one document per filename, so these are not uploaded. Rename them and drop them again.',
    // Held back by the office's name screening (ADR-0086): the files do not
    // leave this computer unless someone releases one of them.
    excluded: '{count, plural, one {# file stays on your computer} other {# files stay on your computer}}',
    excludedExplain:
      'Your office marks these terms as sensitive, so these files are not uploaded. If one of them belongs in Piloti after all, tick it.',
    releaseFile: 'Upload anyway',
    // Files that come in as a new revision of a document already here: by the
    // same name (ADR-0054) or by a name series under another name (ADR-0099).
    // One concept, one word, whichever way Piloti recognised it (ADR-0099). Say
    // document, file, revision: a name with an index does not say what a file is.
    fassung: {
      title: '{count, plural, one {# new revision} other {# new revisions}}',
      consequence:
        'The older revision stays readable, Piloti answers from the new one and notes what changed; unticked files come in as separate documents, and any link can be undone later.',
      sameNameTitle:
        '{count, plural, one {# file of the same name as a new revision} other {# files of the same name as new revisions}}',
      sameNameReason:
        'Same name as a document here: each keeps its name, citations and assignments, and its previous revision stays readable under “Revisions and approval”. Unticked, these are not uploaded.',
      masterAll: '{count, plural, one {As a new revision} other {All # as new revisions}}',
      masterSome: '{ticked} of {count} as new revisions',
      masterNone: '{count, plural, one {Not as a new revision} other {None of # as new revisions}}',
      seriesReason: 'Name series: an index or date in the name continues a document here.',
      ofPrefix: 'Revision of',
      offer: 'File as a new revision of “{name}”',
      unclearTitle: '{count, plural, one {# file needs your choice} other {# files need your choice}}',
      unclearHint: 'Nothing is ticked for you. Choose a document or tick the file, and it is filed as a new revision.',
      reasonNotNewer: 'Not newer than the current revision “{name}”',
      reasonSeveral: 'Several documents could be meant',
      pick: 'Choose the document…',
    },
    showAll: '{count, plural, one {Show the file} other {Show all # files}}',
    action: {
      new: 'New',
      fassung: 'New revision',
      unchanged: 'Unchanged',
      collision: 'Conflict',
      duplicate: 'Already here',
      skipped: 'Skipped',
      excluded: 'Excluded',
    },
    confirm: '{count, plural, one {Upload # file} other {Upload # files}}',
    // The same, when some of them come in as a new revision: the button moves with the boxes.
    confirmWithFassungen:
      '{count, plural, one {Upload # file} other {Upload # files}}, {fassungen, plural, one {# as a new revision} other {# as new revisions}}',
    // Nothing to upload, but the tree still says these belong elsewhere.
    confirmMoveOnly: '{count, plural, one {Move # document} other {Move # documents}}',
    nothingToDo: 'Nothing to upload',
    cancel: 'Cancel',
    // The summary after the plan has been applied.
    done: '{uploaded, plural, one {# file uploaded} other {# files uploaded}}, {skipped} unchanged.',
    doneMoved: '{uploaded, plural, one {# file uploaded} other {# files uploaded}}, {skipped} unchanged, {moved} moved.',
    foldersError: 'The folders for this upload could not be created. Nothing was uploaded.',
    // Distinct from `foldersError`: the folders were made and the upload itself
    // is what went wrong, which is a different thing to retry.
    applyError: 'This folder could not be uploaded completely. Check the list and try again.',
  },
  /**
   * The Outlook archive import (ADR-0085): a .pst or .ost sent in parts, then
   * filed by a background job, one folder per mail.
   */
  mailImport: {
    action: 'Import Outlook archive',
    title: 'Import an Outlook archive',
    description:
      'Choose a .pst or .ost file. Each email becomes a folder under “E-Mail-Import” with its attachments and a note holding its text and headers.',
    privacy:
      'An archive holds the correspondence of everyone who wrote to this mailbox. Import what the project needs, not a whole mailbox.',
    choose: 'Choose archive…',
    maxSize: 'Up to {size}.',
    notAnArchive: '“{name}” is not an Outlook archive (.pst or .ost).',
    tooLarge: '“{name}” is larger than {size}.',
    sending: 'Sending {sent} of {total}…',
    sendingHint:
      'You can go on working in Piloti meanwhile; just keep this tab open until the archive is sent. Filing then runs in the background.',
    sendingLabel: 'Sending “{name}”',
    joining: 'Sent. Piloti is putting the archive together…',
    sendErrors: {
      busy: 'This tab is still sending another archive. Wait until it is sent, then choose this one.',
      alreadyRunning: 'An import of yours is still running in this project. Continue or cancel it first.',
      cancelled: 'The import was cancelled while it was being sent.',
      quota: 'The organization’s storage is full, so the archive cannot be imported.',
      forbidden: 'You may not add documents to this project.',
      rejected: 'Piloti did not accept this archive. Check that it is an Outlook .pst or .ost file.',
      connection: 'The connection broke off. Choose the file again with “Continue sending” to pick up where it stopped.',
      unknown: 'The archive could not be sent. Try again with “Continue sending”.',
    },
    resume: 'Continue sending',
    resumeNamed: 'Continue sending “{name}”',
    resumeHint: 'Choose “{name}” again to continue where sending stopped.',
    resumeMismatch: 'That is not the same file. Choose “{name}” ({size}).',
    resumeChanged:
      '“{name}” has changed since sending began, so its parts no longer fit together. Cancel this import and start a new one.',
    cancel: 'Cancel',
    cancelNamed: 'Cancel the import of “{name}”',
    cancelConfirm: {
      title: 'Cancel this import?',
      description:
        'What has been filed so far stays. The archive is deleted from Piloti, so importing the rest means sending “{name}” again.',
      confirm: 'Cancel import',
      keep: 'Keep importing',
    },
    cancelError: 'The import could not be cancelled.',
    close: 'Close',
    history: 'Imports in this project',
    empty: 'No archive has been imported into this project yet.',
    loadError: 'The imports could not be loaded.',
    openFolder: 'Open folder',
    openFolderNamed: 'Open the folder of “{name}”',
    importingLabel: 'Importing “{name}”',
    startedBy: 'Started by {email}',
    progress: '{done} of {total} items',
    filed: '{mails, plural, one {# email} other {# emails}}, {files, plural, one {# attachment} other {# attachments}}',
    skipped: '{count, plural, one {# skipped} other {# skipped}}',
    skippedItem: '{file} in {mail}: {reason}',
    skippedMail: '{mail}: {reason}',
    status: {
      uploading: 'Sending',
      queued: 'Waiting',
      importing: 'Importing',
      completed: 'Imported',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    errors: {
      unreadable: 'This file could not be read as an Outlook archive. Export it again from Outlook as a .pst file.',
      quota: 'The organization’s storage is full. What was imported until then stays.',
      access: 'The person who started the import may not add documents to this project or its “E-Mail-Import” folder.',
      requester_left: 'The person who started the import is no longer a member of the organization.',
      stopped: 'The import stopped after repeated errors.',
      stalled: 'The import stopped without finishing.',
      upload_expired: 'The archive was not sent completely within two days.',
    },
    reasons: {
      embedded_message: 'attached email',
      type: 'file type not accepted',
      size: 'too large',
      unreadable: 'damaged in the archive',
      screened: 'held back by the office’s name screening',
      access: 'folder is read-only',
      name_taken: 'name already used in the project',
    },
  },
  upload: {
    uploading: 'Uploading…',
    upload: 'Upload',
    uploadFolder: 'Upload folder',
    uploadFiles: 'Choose files',
  },
  errors: {
    projectClosed: 'This project is closed and read-only. Whoever manages it can reopen it from the notice at the top or in the Overview.',
    // Held back by the office's name screening (ADR-0086) on a path with no
    // upload dialog, such as a chat attachment.
    screenedOut: '{count} file(s) not uploaded because your office marks them as sensitive: {files}',
    screenedOutFile: '“{name}” ({reason})',
    // The office's list could not be read: without it nothing is sent, not
    // even against Piloti's suggestion (ADR-0086).
    screeningPolicyUnavailable:
      "Your office's list of sensitive data could not be loaded. Nothing was uploaded. Please try again.",
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
  // The folder brief: what Piloti knows about a folder and everything under it.
  brief: {
    scopeFolder: 'in “{name}” and its subfolders',
    scopeProject: 'in this project',
    scopeOffice: 'in Office filing',
    headlineAll: '{count, plural, one {The document is read} other {All # documents read}}',
    headlineSome: '{readable} of {count, plural, one {# document} other {# documents}} read',
    headlineNone: '{count, plural, one {The document is not read yet} other {None of the # documents read yet}}',
    headlineNothingToRead: '{count, plural, one {# document, not part of the knowledge base} other {# documents, none part of the knowledge base}}',
    states: {
      readable: '{count} read',
      reading: '{count} being read',
      failed: '{count} failed',
      held: '{count} held back',
      unindexed: '{count} not in the knowledge base',
    },
    allRead: 'All read',
    unplacedShort: '{count} without a document type',
    /** Beside the legend: documents Piloti never reads. Not part of the headline's “of N”. */
    unindexedAside: 'plus {count} not in the knowledge base',
    /** Run-in labels of the two chip families under “What this is about”. */
    typesLabel: 'Document type',
    disciplinesLabel: 'Discipline',
    /** Accessible names of the “Show” buttons: three identical buttons are three different things. */
    showFailed: '{count, plural, one {Show the failed document} other {Show the # failed documents}}',
    showHeld: '{count, plural, one {Show the held-back document} other {Show the # held-back documents}}',
    showUnplaced: '{count, plural, one {Show the document without a document type} other {Show the # documents without a document type}}',
    showState: 'Show “{state}” documents across all subfolders',
    showTag: 'Show every “{tag}” document in this folder and its subfolders',
    pages: '{count, plural, one {{formatted} page read} other {{formatted} pages read}}',
    aboutTitle: 'What this is about',
    noTypes: 'Piloti has not recognized a document type here yet.',
    /** "What this is about" while only the folder's counts are loaded (ADR-0102). */
    aboutDeferred: 'Document types, disciplines and topics',
    aboutDeferredHint:
      'What Piloti recognized in the documents is kept with each document. For a large folder it is loaded only when you want to see it.',
    loadDetails: 'Load',
    loadingDetails: 'Loading…',
    contains: 'Contains {list}',
    needsTitle: 'Needs your attention',
    failedLine: '{count, plural, one {Piloti could not read # document.} other {Piloti could not read # documents.}}',
    readAgainAll: '{count, plural, one {Read again} other {Read all # again}}',
    readAgainProgress: 'Starting {done} of {count}…',
    readAgainDone: '{count, plural, one {# document is being read again} other {# documents are being read again}}',
    readAgainPartial: '{count, plural, one {# document could not be restarted} other {# documents could not be restarted}}',
    heldLine:
      '{count, plural, one {# document is held back by the content check until someone reviews it.} other {# documents are held back by the content check until someone reviews them.}}',
    unplacedLine:
      '{count, plural, one {Piloti could not assign # document to a document type.} other {Piloti could not assign # documents to a document type.}}',
    unplacedHint:
      'You don’t have to enter anything, Piloti assigns types on its own. For these, only you can: open the document and choose “Assign”.',
    show: 'Show',
    missingTitle: 'What Piloti is still missing',
    missingLead: 'From the project details, Piloti expects these documents and does not know them yet:',
    missingMore: '+{count} more',
    missingHint:
      'If one of them is already here, Piloti just doesn’t know which file it is, and will call it missing in answers. Read does not mean matched to its role.',
    topicsTitle: 'Topics Piloti recognized',
    photos: '{count, plural, one {# photo} other {# photos}} from {span}',
    whereTitle: 'Where it’s stuck',
    expand: 'Expand',
    collapse: 'Collapse',
    slice: {
      readable: 'Read',
      reading: 'Being read',
      failed: 'Failed',
      held: 'Held back',
      unindexed: 'Not in the knowledge base',
      unplaced: 'Without a document type',
      photos: 'Photos with a date taken',
    },
    sliceScopeFolder: '“{name}” and its subfolders',
    sliceScopeRoot: 'all folders',
    sliceClear: 'Back to the folder',
    sliceEmpty: 'Nothing left here.',
  },
  /** The count on a document's card and row when it has Fassungen under other file names (ADR-0099). */
  fassungBadge: {
    count: '{count, plural, one {# revision} other {# revisions}}',
    countTitle: '{count, plural, one {# revision of this document} other {# revisions of this document}}',
    older: 'Older revision',
    /** Tooltip of an older revision: what replaced it. {name} is the newer one's file name. */
    olderTitle: 'Replaced by “{name}”',
  },
  /** Visual comparison of two Fassungen: side by side, overlaid, swiped (fassung-compare/). */
  compare: {
    title: 'Compare revisions',
    olderLabel: 'Older',
    newerLabel: 'Newer',
    close: 'Close',
    viewMode: 'View mode',
    modeSide: 'Side by side',
    modeOverlay: 'Overlay',
    modeSwipe: 'Swipe',
    legendOlder: 'Older (cyan)',
    legendNewer: 'Newer (orange)',
    legendLabel: 'Color key',
    legendUnchanged: 'Unchanged (dark)',
    captionOlder: 'Older revision',
    captionNewer: 'Newer revision',
    paneOlder: 'Older revision: {name}',
    paneNewer: 'Newer revision: {name}',
    pageOf: 'Page {n} of {m}',
    pageOfTotal: 'of {m}',
    pageInput: 'Page, {m} in total',
    pageNavigation: 'Page',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    pageCountDiffers: 'These revisions differ in page count: {older} against {newer}.',
    pageMissing: 'This revision has no page {n}.',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomLabel: 'Zoom',
    zoomFit: 'Fit',
    zoomPercent: '{percent}%',
    zoomFitActive: 'Whole page fitted',
    zoomFitAction: '{percent}% of the fitted size. Fit the whole page',
    zoomHint: 'Ctrl + scroll or two fingers to zoom, drag to pan',
    opacity: 'Show newer revision',
    opacityValue: '{percent}%',
    swipeDivider: 'Divider between the older and the newer revision',
    swipeValue: '{percent}% older revision',
    swipeHint: 'Drag or use ← → to move, double-click to centre',
    keysHint: 'Arrow keys change the page, 1, 2 and 3 the view, Esc closes the comparison.',
    keysHintVisible: '← → change page · 1 2 3 view · Esc close',
    loading: 'Loading the pages…',
    failedFile: 'The pages of {name} could not be loaded.',
    failedBoth: 'The pages of both revisions could not be loaded.',
    failedDescription: 'Often the connection only dropped for a moment. If a second try does not help, open the file on its own.',
    retry: 'Try again',
    notComparableTitle: 'These files cannot be compared visually',
    notComparableDescription:
      'Only pages and images can be laid over each other. The text comparison in the revision history shows what changed in the wording.',
    openTextCompare: 'Open text comparison',
    backToHistory: 'Back to the revision history',
    changesRegion: 'Changes',
    changesHeading: 'Changes ({count})',
    pageGroup: 'Page {page}',
    pageGroupShown: 'on screen',
    changeShow: 'Change {number}: {label}. Show on the page.',
    changeTag: 'Change {number}: {label}',
    markPage: 'Compare page {page} with Piloti',
    markingPage: 'Piloti is comparing page {page}…',
    markedPage: 'Page {page} is marked',
    markPageMissing: 'Only one revision has page {page}',
    markSlow: 'This usually takes a few seconds.',
    caveat: 'Marked by Piloti. Check dimensions in the document.',
    markNotRead: 'This revision is still being read. You can compare as soon as it is citable.',
    markUnavailable: 'Piloti is not reachable right now. Try again in a minute.',
    markFailed: 'The comparison failed. Please try again.',
  },
  filters: {
    label: 'Filter',
    labelActive: 'Filters ({count} active)',
    reset: 'Reset filters',
    // The two toggles that WIDEN: retired files are not in the listing at all,
    // and older revisions are one entry with the current one (ADR-0099). Worded
    // alike under one heading, so neither reads as a narrowing.
    alsoShowLabel: 'Also show',
    alsoShow: {
      retired: 'Retired',
      olderFassungen: 'Older revisions',
    },
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
      processing: 'Reading',
      ready: 'Citable',
    },
    originLabel: 'Origin and approval',
    tagLabel: 'Category',
    kindLabel: 'File type',
    kind: {
      floorplan: 'Floor plan',
      section: 'Section / elevation',
      siteplan: 'Site plan',
      notice: 'Official notice',
      photo: 'Photo',
      model: '3D model (IFC)',
      sheet: 'Spreadsheet',
      text: 'Text / note',
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
  /**
   * Fassungen und Freigabe — the editorial state of a document (ADR-0054).
   *
   * A separate vocabulary from `status`, which is where a document is in the
   * INGESTION pipeline. „Freigegeben" and „Zitierbar" answer different
   * questions, and the two word lists must not borrow from each other.
   */
  lifecycle: {
    title: 'Revisions and approval',
    /** Hover text on the badge; the state word is interpolated. */
    badgeTitle: 'Approval status: {state}',
    /** The filter chip, beside By Piloti. */
    filter: 'Awaiting approval',
    states: {
      draft: 'Draft',
      inReview: 'In review',
      changesRequested: 'Changes requested',
      approved: 'Approved',
      published: 'Published',
      rejected: 'Rejected',
      superseded: 'Replaced',
      /**
       * NOT "archived". Office filing (Büroablage, once "Archiv") is where a
       * document is placed so that it BECOMES cross-project office knowledge.
       * This state is the opposite: the file leaves the working set and its
       * knowledge-base entries are purged. One word for both would be the same
       * verb for a thing and its inverse. The column value stays `archived` —
       * that is wire and database, not the reader's language.
       */
      archived: 'Retired',
    },
    actions: {
      submit: 'Submit for approval',
      approve: 'Approve',
      requestChanges: 'Request changes',
      /** The same decision, plus one thing: Piloti writes the next revision. */
      delegateRevision: 'Have Piloti revise it',
      reject: 'Reject',
      publish: 'Publish',
      archive: 'Retire',
      /** The ⋯ beside “Request changes”: have Piloti revise it, reject. */
      more: 'More decisions',
    },
    /** Who should approve the revision. Everyone who may is the default. */
    reviewer: {
      every: 'All editors',
    },
    /**
     * Submitting for approval is a liability-adjacent act: the submitter names
     * a reviewer and states the order in one sentence. Both gate the button —
     * a disabled button with its reason, never a silent refusal or an open
     * round nobody was told about.
     */
    submit: {
      reviewerLabel: 'Reviewer',
      reviewerPlaceholder: 'Choose a reviewer',
      orderLabel: 'Order for the reviewer',
      orderPlaceholder: 'In one sentence: what should be checked?',
      dueLabel: 'Due date (optional)',
      needReviewer: 'Choose who should review this revision.',
      needOrder: 'State the order in one sentence.',
      selfReviewNote:
        'No other editors — the approval will be recorded as a self-review.',
    },
    /**
     * Approving is the office asserting the content, so it is never one click:
     * the act names its stand (revision + date), the acting person and the
     * moment, and the checkbox is the signature.
     */
    approveConfirm: {
      stand: 'Revision {number} · as of {date}',
      actingWithName: 'Acting: {name} · {date}',
      actingDateOnly: 'Acting: {date}',
      checkbox: 'I approve this revision',
    },
    /**
     * Publication is its own act in its own section — never a sibling button
     * beside approval. Approving asserts the content; publishing makes the
     * revision the one Piloti answers from: only a published revision is read
     * into the knowledge base (ADR-0054).
     */
    publishSection: {
      heading: 'Publication',
      blurb: 'Publishing makes revision {number} the one Piloti answers from.',
    },
    /**
     * Archiving is the one act in this section that cannot be taken back from
     * inside the product: the knowledge-base entries are purged and no route
     * brings them back. So it stands apart and states its consequences before
     * it runs — never a fifth button in a row of review decisions.
     */
    archiveSection: {
      heading: 'Take out of the file list',
      blurb:
        'Retiring removes the file from the file list and from the knowledge base. Nothing is deleted.',
      confirmTitle: 'Retire this file?',
      confirmTitleNamed: 'Retire “{filename}”?',
      consequences: {
        listing:
          'The file leaves the file list. The “Also show retired” filter brings it back into view.',
        knowledge: 'Piloti stops citing it: its knowledge-base entries are removed.',
        kept: 'The file and every revision are kept. This is not a delete.',
        permanent: 'This cannot be undone here.',
      },
    },
    /**
     * What a state means for the reader, in one sentence. The state words
     * („In review", „Approved") are only informative to somebody who knows what
     * a state changes, and exactly one thing changes: whether Piloti answers
     * from this revision. Only a published revision is read into the knowledge
     * base (ADR-0054); when none stands behind the newest one, the sentence
     * cannot point at it („Alone").
     */
    meaning: {
      draftLive: 'A draft of a new revision. Piloti keeps answering from the published revision.',
      draftAlone: 'A draft. Piloti answers from it only once it is approved and published.',
      inReviewLive: 'Waiting for approval. Piloti answers from the published revision.',
      inReviewAlone: 'Waiting for approval. Until then Piloti does not answer from it.',
      changesRequestedLive:
        'Changes requested. Piloti answers from the published revision until the reworked one is published.',
      changesRequestedAlone:
        'Changes requested. Piloti answers from the reworked revision only once it is published.',
      approvedLive:
        'Approved, waiting to be published. Until then Piloti answers from the published revision.',
      approvedAlone: 'Approved, waiting to be published. Only then does Piloti answer from it.',
      published: 'Piloti answers from this revision.',
      rejectedLive: 'Rejected. Piloti answers from the published revision.',
      rejectedAlone: 'Rejected. Piloti does not answer from it.',
      superseded: 'Replaced by a newer revision.',
      archived: 'Retired. Gone from the file list; Piloti stops citing it.',
      none: 'No revision yet.',
      olderFassung: 'An older revision. Piloti answers from the newer one.',
    },
    comment: {
      /** Rejecting needs a reason; asking for changes needs the changes. */
      reasonLabel: 'Reason for rejection',
      changesLabel: 'What needs to change',
      /** Said where the decision is taken, not in a tooltip. */
      delegateNote: 'Piloti then drafts the next revision and submits it for approval.',
      placeholder: 'The next revision reads this.',
      cancel: 'Cancel',
    },
    versions: {
      number: 'Revision {number}',
      comparing: 'Loading both revisions…',
      compareFailed: 'The two revisions could not be loaded.',
      /**
       * The line diff. No red and no green anywhere in it: chroma belongs to
       * provenance, and an editorial change is not provenance, so a changed line
       * is marked by a left rule, a `+`/`−` gutter and its ink weight instead.
       * `addedLine` / `removedLine` are the screen-reader words behind the two
       * markers — nothing here may depend on seeing a glyph.
       */
      diff: {
        heading: 'What changed',
        between: 'Revision {from} → revision {to}',
        added: '{count, plural, one {# line added} other {# lines added}}',
        removed: '{count, plural, one {# line removed} other {# lines removed}}',
        gap: '{count, plural, one {# line unchanged} other {# lines unchanged}}',
        identical: 'The two revisions are identical, line for line.',
        truncated: 'This comparison is long — showing the first {count} lines.',
        addedLine: 'added',
        removedLine: 'removed',
      },
      uploaded: 'Uploaded',
      created: 'Created',
      submitted: 'Submitted',
      approved: 'Approved',
      published: 'Published',
      // Refusals leave milestones too: a revision sent back must name who sent
      // it and when, or the refusal is invisible in the history.
      changesRequested: 'Changes requested',
      rejected: 'Rejected',
      byAt: 'by {name}, {time}',
      you: 'you',
      someone: 'someone',
    },
    errors: {
      /** The compare-and-swap lost: somebody decided first, so re-read. */
      conflict: 'Someone decided first. Reloading the current revision.',
      /** The file has not passed its upload screening yet (ADR-0086). */
      held: 'This file is still being checked. You can submit it once the check is complete.',
      actionFailed: 'That did not go through. Nothing has changed.',
      loadFailed: 'The revision history could not be loaded.',
    },
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
    // One word for one gesture, on all three surfaces: the file pane, the report
    // card and the inbox row.
    discuss: 'Discuss',
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
      'Piloti searches this document. Other project files and Office filing stay out.',
    subjectClear: 'Stop focusing on this file',
    loadingPeople: 'Loading people…',
    noPeople: 'No one in this project yet',
    peopleLoadError: 'Could not load people',
    assignError: '“{name}” could not be made responsible',
    unassignError: '“{name}” could not be removed',
    tryAgain: 'Try again',
  },
}
