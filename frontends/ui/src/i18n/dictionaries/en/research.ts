/** The research workspace: chat shell, panels, and deep-research detail views. */
export const research = {
  dismissError: 'Dismiss error',

  // Shared empty-state helper shown across the deep-research detail tabs
  // (Thinking, Thought Traces, Tool Calls, Agents, Files).
  detailsHelp:
    'These details appear during active research and may not be available for completed reports.',

  // Label for a run whose chat has no local title (headless/CLI jobs).
  runsList: {
    untitledRun: 'Deep research run',
  },

  chatArea: {
    ariaMessages: 'Chat messages',
    loading: 'Loading conversation',
    typing: 'Piloti is responding …',
    scrollToLatest: 'Scroll to latest',
    status: {
      thinking: 'Thinking …',
      searching: 'Searching …',
      planning: 'Planning …',
      researching: 'Researching …',
      writing: 'Writing …',
    },
    loggedOutTitle: 'Piloti opens after your organization is verified.',
    loggedOutBody:
      'Sign in to unlock the project workspace: your files, the office archive, and the building-regulation corpus.',
    signInSso: 'Sign in with SSO',
    welcomeTitle: 'How can Piloti help with your project?',
  },

  chatToolbar: {
    createNewSession: 'Create new session',
    signInToCreate: 'Sign in to create sessions',
    cannotCreateActive: 'Cannot create a new session while the current session is active',
    newChat: 'New chat',
    toggleSessions: 'Chat history',
    signInToView: 'Sign in to view your chat history',
    sessions: 'Sessions',
    addSources: 'Add data sources',
    signInToManage: 'Sign in to manage data sources',
    sources: 'Sources',
    research: 'Research',
    /** Trigger for the thread menu that holds every non-primary header action. */
    moreActions: 'More actions',
    renameSession: 'Rename chat',
    /** The persistent "still working" signal while a run is going in the thread. */
    researching: 'Researching',
  },

  dataSources: {
    loading: 'Loading data sources',
    loadingEllipsis: 'Loading data sources...',
    unableToLoad: 'Unable to load data sources',
    retryAria: 'Retry loading data sources',
  },

  /**
   * Datenbasis — the composer control for WHERE Piloti may look.
   *
   * One name for one thing: this object retires the four competing labels the
   * same surface used to carry. Tense is meaning here — the control speaks only
   * in the present/permissive ("may search"); what was actually used is the
   * Herleitung's job to report, never this control's.
   */
  sourceBasis: {
    label: 'Data basis',
    triggerAria: 'Data basis: {summary}. Opens the picker.',
    description: 'Where Piloti may search. What it actually used is in the derivation.',
    allSources: 'All sources',
    internalOnly: 'Project knowledge only',
    overflowAria: '{count, plural, one {# more source type} other {# more source types}}',
    alwaysOn: 'Always included',
    alwaysOnChip: 'Always on',
    external: 'External sources',
    signInRequired: 'Sign-in required',
    signInReason: 'Sign in to use this source.',
    lockedBusy: 'The data basis cannot be changed while research is running.',
    noExternalWarning: 'Piloti will then search only your project documents.',
    presetsLabel: 'Presets',
    emptyTitle: 'No external sources',
    emptyBody:
      'No external sources are enabled for this project right now. Piloti searches your project documents.',
    toggleAria: 'Allow {name}',
    /** Stratum wordmarks — always shown together with their icon and colour. */
    strata: {
      law: 'Building law',
      office: 'Office archive',
      project: 'Project knowledge',
      auto: 'Web',
    },
    /** Presets in the picker footer — "All" makes the normal case nameable. */
    presets: {
      all: 'All sources',
      law: 'Building law & guidelines',
      project: 'Project documents',
      office: 'Office archive',
    },
    /**
     * The knowledge layer is not a toggleable source — it rides along on every
     * turn. It is listed here instead of being filtered away and skewing the
     * count.
     */
    knowledge: {
      projectName: 'Project knowledge',
      projectDescription: 'Your project documents in this project.',
      officeName: 'Office archive',
      officeDescription: 'Shared documents from your office.',
    },
  },

  deleteModals: {
    cannotReverse: 'This action cannot be reversed. Are you sure you want to do this?',
    aboutToDelete: 'You are about to delete',
    lossSuffix: '. You will lose all progress and any files you have attached will be removed.',
    all: {
      title: 'Delete all chats in this project?',
      countSessions:
        '{count, plural, one {the one chat in this project} other {all # chats in this project}}',
      allSessions: 'EVERY chat in this project',
      scopeNote: 'Only chats in this project are deleted. Your chats in other projects are not affected.',
      confirm: 'Delete all chats',
    },
    file: {
      title: 'Delete File',
      thisFile: 'this file',
      suffix: '. This will completely remove it from your chat.',
      confirm: 'Delete File',
    },
    session: {
      title: 'Delete this chat?',
      thisSession: 'this chat',
      confirm: 'Delete chat',
    },
  },





  fileCard: {
    lines: '{count, plural, one {# line} other {# lines}}',
    content: 'Content',
  },

  fileSourceCard: {
    statusUploading: 'Uploading...',
    statusIngesting: 'Processing...',
    statusAvailable: 'Available',
    statusError: 'Error',
    statusDeleting: 'Deleting...',
    expiryPending: 'Deletion Pending - Reupload',
    expiresIn: 'Expires in {minutes} min',
    deleteDisabled: 'Delete {title} (disabled)',
    delete: 'Delete {title}',
    waitUpload: 'Wait for upload to complete',
    cannotDeleteBusy: 'Cannot delete files during active operations',
    deleteFile: 'Delete file',
    open: 'Open preview: {title}',
  },

  fileSourcesTab: {
    uploadTo: 'Upload To',
    targetProject: 'Project knowledge',
    targetSession: 'Private session',
    targetProjectLower: 'project knowledge',
    targetSessionLower: 'private session',
    availableInProject: 'Available in this project.',
    preparingCorpus: 'Preparing project knowledge...',
    onlyThisSession: 'Only available in this chat session.',
    loadingFiles: 'Loading files',
    checkingFiles: 'Checking for files...',
    setupBackend: 'Files become available once the connection to Piloti is up.',
    noAttachedFiles: 'No Attached Files',
    filesGoTo: 'Files uploaded here go to {target} unless removed.',
    filesCount: '{target} Files ({count})',
    loadingFilesEllipsis: 'Loading files...',
    addFiles: 'Add files',
    uploadNotAvailable: 'File upload not available',
    addFile: '+ Add File',
  },

  inputArea: {
    /**
     * Clearing the composer's file subject ends two things at once — the
     * retrieval focus and the open viewer — so it is the one control in the
     * file flow that cannot be walked back by pressing it again. The toast
     * carries the way back.
     */
    subjectCleared: 'No longer asking about that file.',
    subjectClearedUndo: 'Undo',
    aiDisclosure:
      'Piloti is an AI — answers can be wrong; verify them against the cited files.',
    placeholderDefault: 'Check data sources and ask a research question...',
    signInToStart: 'Sign in to start working',
    typeResponse: 'Type your response to Piloti...',
    pleaseWait: 'Please wait...',
    messageNotSent: 'Message not sent',
    messageNotSentDesc: 'Something went wrong sending your message. Please try again.',
    unsupportedFileType: 'Unsupported file type',
    dropToUpload: 'Drop files to upload',
    accepts: 'Accepts: {types}',
    openFiles: 'Open uploaded files',
    availableFiles: 'Available files',
    uploadNotAvailable: 'File upload not available',
    attachFiles: 'Attach files',
    uploadDisabledBusy: 'File upload disabled during active operations',
    selectFiles: 'Select files to upload',
    sendResponse: 'Send response',
    sendMessage: 'Send message',
    sendQuery: 'Send query',
    responseInput: 'Response input',
    chatMessageInput: 'Chat message input',
    stopStreaming: 'Stop response',
    sendWhilePending: 'Files are still processing — send anyway?',
    heldForUpload: 'Sending as soon as the file has been read.',
    heldForUploadSendNow: 'Ask now without it',
    removeFile: 'Remove file: {name}',
    retryUpload: 'Retry upload',
    manageFiles: 'Manage files',
    manageFilesCount: 'Manage attached files ({count})',
    manageFilesMobile: 'Manage {count, plural, one {# file} other {# files}}',
    openFile: 'Open file: {name}',
    fileUploadingStatus: 'Uploading',
    fileFailedStatus: 'Upload failed',
    fileReadyStatus: 'Ready',
  },





  sessionsPanel: {
    title: 'Chat history',
    /** The sheet's close control (grabber pill + desktop X). */
    close: 'Close chat history',
    /** Shown beside the title so the panel states its own size. */
    countLabel: '{count, plural, one {# chat} other {# chats}}',
    countLabelOne: '1 chat',
    // Chats persist server-side (Postgres via /api/conversations) for every
    // chat, unconditionally — this line must never claim they live in the
    // browser, and must never advise deleting chats to free local space:
    // deleting a chat deletes the server copy too.
    syncedNote:
      'Chats are saved to your workspace and available on any device. Research reports may expire on the server.',
    deleteAllDisabled: 'Delete all chats in this project (disabled)',
    deleteAll: 'Delete all chats in this project',
    cannotDeleteBusy: 'Cannot delete while operations are in progress',
    deleteAllButton: 'Delete all chats',
    /** Stop action for a stuck deep-research run (chat row, run row). */
    stopResearch: 'Stop research',
    stopResearchTitle: 'Stop this research run',
    /** Stopping cancels server-side work that cannot be resumed (shared ConfirmDialog, warning tone). */
    stopConfirmTitle: 'Stop research?',
    stopConfirmBody:
      'The running research will be cancelled and cannot be resumed. Partial progress so far stays visible in the research panel.',
    stopConfirmConfirm: 'Stop research',
    newSessionDisabled: 'Start a new chat (disabled during active operations)',
    startNewSession: 'Start a new chat',
    cannotCreateActive: 'Cannot start a new chat while this one is still answering',
    newSessionButton: 'New chat',
    searchPlaceholder: 'Search chats',
    searchAria: 'Search chats',
    clearSearch: 'Clear search',
    /** Live result count under the search field while a query is active. */
    searchResults: '{count} of {total} chats',
    noMatching: 'No matching chats',
    noMatchingDescription: 'Nothing in this project matches “{query}”.',
    noSessions: 'No chats yet',
    noSessionsDescription: 'Your chats with Piloti in this project will be listed here.',
    /** Explains why every row is dimmed and unclickable mid-answer. */
    navigationBlocked:
      'Piloti is still answering. Starting or switching chats is paused until it finishes.',
    today: 'Today',
    yesterday: 'Yesterday',
    editTitle: 'Edit chat title',
    untitledSession: 'Untitled chat',
    renameDisabled: 'Rename chat (disabled)',
    rename: 'Rename chat',
    cannotRenameBusy: 'Cannot rename while operations are in progress',
    deleteDisabled: 'Delete chat (disabled)',
    deleteSession: 'Delete chat',
    sessionActive: 'Working on this chat',
    reportCompleted: 'Report ready',
    chatSession: 'Chat',
    sessionLabelBusy: 'Chat: {title} (processing in progress)',
    sessionLabel: 'Chat: {title}',
    /** Same row, plus the state its leading icon depicts. */
    sessionLabelWithStatus: 'Chat: {title} — {status}',
    // FB-10: Deep Research section folded into the sessions panel. The count
    // rides in a CountPill beside the heading, not in the string.
    deepResearchHeading: 'Deep Research',
    deepResearchChip: 'Deep Research',
    deepResearchRunLabel: 'Open deep research run: {label} — {status}',
    /** Scope filter over the one list — chats, runs, or both. */
    filterAria: 'Filter history',
    filterAll: 'All',
    filterChats: 'Chats',
    filterResearch: 'Deep Research',
    /** A failed runs fetch says so — an empty section would misreport it. */
    researchLoadFailed: 'Deep-research runs could not be loaded.',
    noRuns: 'No deep research runs yet',
    noRunsDescription: 'Deep research runs from this project will be listed here.',
    /** A run's state, in words — the icon alone made "failed" and "ready" look alike. */
    runStatus: {
      running: 'Running',
      completed: 'Report ready',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
  },









}
