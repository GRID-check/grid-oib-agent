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
    indexed: {
      title: 'Read by Piloti',
      documentType: 'Document type',
      project: 'Project',
      updated: 'Updated',
      caption: 'Automatically detected on upload — your corrections improve future answers.',
      pending: 'Piloti is still reading this document – its summary and properties appear here once it is done.',
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
    ingestionFailedPreviousVersionKept:
      'Search and Piloti still use the previous version. The download serves the new file.',
    retryIngestion: 'Read again',
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
     * The same failure on a document with an earlier version: the index keeps
     * that version's passages, so the file is still citable, just not the new
     * bytes. Mirrors `ingestionFailedPreviousVersionKept` in the pane.
     */
    peekFailedPreviousVersionHint:
      'The new file could not be read — Piloti is still citing the previous version.',
    /** The way out of that: the enlarged view carries the error and the retry. */
    peekFailedAction: 'Details',
  },
  /**
   * Why a document could not be read, by the category
   * `features/documents/lib/ingest-failure.ts` gives the stored error. The raw
   * text stays behind `details`.
   */
  ingestFailure: {
    rendition_failed: "The PDF version of this file couldn't be created. Try reading it again, or upload it as a PDF.",
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
      'This file contains something your office marks as sensitive. Piloti showed it to no model. An office or project admin releases or deletes it.',
    unknown: "Piloti couldn't read this document, so search can't find it.",
    details: 'Details',
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
    newInside: 'New folder inside',
    open: 'Open',
    move: 'Move to folder',
    items: '{count} item(s)',
    openFolder: 'Open folder “{name}”',
    breadcrumb: 'Folder path',
    movedFolder: '“{name}” moved to “{parent}”.',
    moveFolderError: 'The folder could not be moved. Please try again.',
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
    reingestConfirmTitle: 'Read “{name}” again?',
    reingestConfirmDescription:
      'Piloti reads the file again from scratch, for example to pick up the pictures in Word and PowerPoint files. Answers keep using the current version until the new one is ready.',
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
    single: {
      updateTitle: 'Upload a new version of “{name}”?',
      updateExplain:
        '“{name}” is already here. The new version becomes the current one; the previous one stays under Versions.',
      unchangedTitle: 'Unchanged – already here',
      unchangedExplain: '“{name}” is identical to this file. Nothing is uploaded.',
      refiled: 'The document is currently in another folder and moves to “{folder}”.',
      archived: 'The document is archived. The new version is added to it and only shows in the list again once the document is restored.',
      confirmUpdate: 'Upload as new version',
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
    updatePrompt: 'Update the {count} document(s) that already exist',
    updateExplain:
      'They keep their name, their citations and everything assigned to them. The new version becomes the current one; the previous one stays under Versions.',
    refiled: '{count} of them are filed elsewhere at the moment and move to where this folder puts them.',
    // The unchanged ones send no bytes, so nothing about the upload would move
    // them — they are moved on their own, or the tree is not really recreated.
    moving: '{count} unchanged document(s) are filed elsewhere and are moved to where this folder puts them.',
    duplicates: '{count} file(s) are already in the project under a different name',
    duplicatesExplain:
      'Uploading them would add a second copy rather than replace anything, so they are not sent. Rename the document here, or the file on disk, so the two agree.',
    collisions: '{count} files share a name with another file in this upload',
    collisionsExplain:
      'A project holds one document per filename, so these are not uploaded. Rename them and drop them again.',
    showAll: 'Show all {count} files',
    action: {
      new: 'New',
      update: 'Update',
      unchanged: 'Unchanged',
      collision: 'Conflict',
      duplicate: 'Already here',
      skipped: 'Skipped',
    },
    confirm: 'Upload {count} file(s)',
    // Nothing to upload, but the tree still says these belong elsewhere.
    confirmMoveOnly: 'Move {count} document(s)',
    nothingToDo: 'Nothing to upload',
    cancel: 'Cancel',
    // The summary after the plan has been applied.
    done: '{uploaded} file(s) uploaded, {skipped} unchanged.',
    doneMoved: '{uploaded} file(s) uploaded, {skipped} unchanged, {moved} moved.',
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
      access: 'The person who started the import may no longer add documents to this project.',
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
    },
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
      processing: 'Reading',
      ready: 'Citable',
    },
    originLabel: 'Origin',
    tagLabel: 'Category',
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
  /**
   * Freigabe und Fassungen — the editorial state of a document (ADR-0054).
   *
   * A separate vocabulary from `status`, which is where a document is in the
   * INGESTION pipeline. „Freigegeben" and „Zitierbar" answer different
   * questions, and the two word lists must not borrow from each other.
   */
  lifecycle: {
    title: 'Approval and versions',
    /** Hover text on the badge; the state word is interpolated. */
    badgeTitle: 'Version status: {state}',
    /** The filter chip, beside By Piloti. */
    filter: 'Awaiting approval',
    /** The one filter that WIDENS: retired files are not in the listing at all. */
    archivedFilter: 'Also show retired',
    states: {
      draft: 'Draft',
      inReview: 'In review',
      changesRequested: 'Changes requested',
      approved: 'Approved',
      published: 'Published',
      rejected: 'Rejected',
      superseded: 'Superseded',
      /**
       * NOT "archived". This product's Archiv is the office archive, where a
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
      /** The same decision, plus one thing: Piloti writes the next version. */
      delegateRevision: 'Have Piloti revise it',
      reject: 'Reject',
      publish: 'Publish',
      archive: 'Retire',
    },
    /** Who should release the version. Everyone who may is the default. */
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
      needReviewer: 'Choose who should review this version.',
      needOrder: 'State the order in one sentence.',
      selfReviewNote:
        'No other editors — the approval will be recorded as a self-review.',
    },
    /**
     * Approving is the office asserting the content, so it is never one click:
     * the act names its stand (version + date), the acting person and the
     * moment, and the checkbox is the signature.
     */
    approveConfirm: {
      stand: 'Version {number} · as of {date}',
      actingWithName: 'Acting: {name} · {date}',
      actingDateOnly: 'Acting: {date}',
      checkbox: 'I release this version',
    },
    /**
     * Publication is its own act in its own section — never a sibling button
     * beside approval. Approving asserts the content; publishing issues it to
     * the submission set / the authority.
     */
    publishSection: {
      heading: 'Publication',
      blurb: 'Target: submission set / authority — version {number} is issued.',
    },
    /**
     * Archiving is the one act in this section that cannot be taken back from
     * inside the product: the knowledge-base entries are purged and no route
     * brings them back. So it stands apart and states its consequences before
     * it runs — never a fifth button in a row of review decisions.
     */
    archiveSection: {
      heading: 'Take out of the working set',
      blurb:
        'Retiring removes the file from the file list and from the knowledge base. Nothing is deleted.',
      confirmTitle: 'Retire this file?',
      confirmTitleNamed: 'Retire “{filename}”?',
      consequences: {
        listing:
          'The file leaves the file list. The “Also show retired” filter brings it back into view.',
        knowledge: 'Piloti stops citing it: its knowledge-base entries are removed.',
        kept: 'The file and every version are kept — this is not a delete.',
        permanent: 'This cannot be undone here.',
      },
    },
    /**
     * A control that is not offered is a muted line, never nothing: the reader
     * sees what the version is waiting for and — where that is a known fact —
     * who submitted it. Who was ASKED is server-side (the reviewer chain), so
     * no name is invented for them.
     */
    waiting: {
      draft: 'Draft — waiting to be submitted for approval.',
      inReview: 'In review — waiting for approval.',
      inReviewBy: 'In review — waiting for approval · submitted by {name}.',
      changesRequested: 'Changes requested — waiting for a new version.',
      approved: 'Approved — waiting to be published.',
      published: 'Published — no further step.',
      rejected: 'Rejected — no further step.',
      superseded: 'Superseded by a newer version.',
      archived: 'Retired — no longer in the working set.',
      none: 'No version yet.',
    },
    comment: {
      /** Rejecting needs a reason; asking for changes needs the changes. */
      reasonLabel: 'Reason for rejection',
      changesLabel: 'What needs to change',
      /** Said where the decision is taken, not in a tooltip. */
      delegateNote: 'Piloti then drafts the next version and submits it for approval.',
      placeholder: 'The next version reads this.',
      cancel: 'Cancel',
    },
    versions: {
      title: 'Versions',
      number: 'Version {number}',
      /** The version the document currently serves. */
      live: 'Current',
      open: 'Open',
      compare: 'Compare with {number}',
      comparing: 'Loading both versions…',
      compareFailed: 'The two versions could not be loaded.',
      /**
       * The line diff. No red and no green anywhere in it: chroma belongs to
       * provenance, and an editorial change is not provenance, so a changed line
       * is marked by a left rule, a `+`/`−` gutter and its ink weight instead.
       * `addedLine` / `removedLine` are the screen-reader words behind the two
       * markers — nothing here may depend on seeing a glyph.
       */
      diff: {
        heading: 'What changed',
        between: 'Version {from} → version {to}',
        added: '{count, plural, one {# line added} other {# lines added}}',
        removed: '{count, plural, one {# line removed} other {# lines removed}}',
        gap: '{count, plural, one {# line unchanged} other {# lines unchanged}}',
        identical: 'The two versions are identical, line for line.',
        truncated: 'This comparison is long — showing the first {count} lines.',
        addedLine: 'added',
        removedLine: 'removed',
      },
      submitted: 'Submitted',
      approved: 'Approved',
      published: 'Published',
      // Refusals leave milestones too: a version sent back must name who sent
      // it and when, or the refusal is invisible in the history.
      changesRequested: 'Changes requested',
      rejected: 'Rejected',
      byAt: 'by {name}, {time}',
      you: 'you',
      someone: 'someone',
    },
    errors: {
      /** The compare-and-swap lost: somebody decided first, so re-read. */
      conflict: 'This has moved on — reloading the current state.',
      actionFailed: 'That did not go through. Nothing has changed.',
      loadFailed: 'The version history could not be loaded.',
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
