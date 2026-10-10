/** Office filing (Büroablage): the org-wide, top-level, cross-project document store (ADR-0024). */
export const archiv = {
  title: 'Office filing',
  subtitle: 'Shared documents available to every project in your organization',
  backToApp: 'Back to projects',
  backToProject: 'Back to project',
  backToNamedProject: 'Back to {name}',
  // What only the Büroablage card says: the gold kind chip and where it came from.
  library: {
    provenance: 'From: {source}',
    kind: {
      floorplan: 'Floor plan',
      section: 'Section / elevation',
      siteplan: 'Site plan',
      notice: 'Notice',
      photo: 'Photo',
      // `model` was missing while `inferDocumentKind` had been returning it for
      // every `.ifc` — the card printed the raw key. A building is not a
      // document, and the label says so.
      model: 'Building model',
      sheet: 'Spreadsheet',
      text: 'Notes',
      document: 'Document',
    },
  },
  toast: {
    // Fired the instant async ingestion finishes and the document becomes
    // citable across every project in the organization.
    ingestionComplete: '“{name}” is now in Office filing — citable',
  },
  workspace: {
    dropToUpload: 'Drop files to add them to Office filing',
  },
  actions: {
    label: 'File actions for “{name}”',
    reingest: 'Read again',
    reingesting: 'Retrying…',
    reingestError: "Reading couldn't be restarted. Please try again.",
    reingestRunning: 'Already being read',
    reingestAlreadyDone: 'Already finished',
    reingestConfirmTitle: 'Read “{name}” again?',
    reingestConfirmDescription:
      'Piloti reads the file again from scratch, for example to pick up the pictures in Word and PowerPoint files. Answers keep using the current version until the new one is ready.',
    reingestConfirmAction: 'Read again',
    menuLabel: 'File actions',
    download: 'Download',
    open: 'Open',
    ask: 'Ask about this',
    copyOriginPath: 'Copy origin path',
    moved: '“{name}” moved to {folder}',
    moveError: 'The document could not be moved. Please try again.',
    move: 'Move to folder',
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
    action: 'Delete from Office filing',
    title: 'Delete “{name}”?',
    confirm: 'This removes the document for the whole organization. This cannot be undone.',
    confirmAction: 'Delete',
    cancel: 'Cancel',
    deleting: 'Deleting…',
    success: '“{name}” was removed from Office filing',
    error: 'The document could not be deleted',
    legalHold: 'The document is under a legal hold and cannot be deleted',
  },
}
