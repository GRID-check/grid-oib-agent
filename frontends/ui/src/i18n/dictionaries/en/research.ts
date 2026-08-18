/** The research workspace: chat shell, panels, and deep-research detail views. */
export const research = {
  dismissError: 'Dismiss error',

  // Shared empty-state helper shown across the deep-research detail tabs
  // (Thinking, Thought Traces, Tool Calls, Agents, Files).
  detailsHelp:
    'These details appear during active research and may not be available for completed reports.',

  runsPage: {
    title: 'Research runs',
    subtitle: 'Deep research reports Piloti has produced for this project, newest first.',
  },

  // Labels for the per-project research-runs list rows (research-runs-list.tsx).
  runsList: {
    untitledRun: 'Deep research run',
    sessionLabel: 'Session {id}',
    viewThinking: 'View thinking',
  },

  dockedPanel: {
    closePanel: 'Close panel',
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
      'Sign in to unlock project-scoped OIB research, document ingestion, and member access controls.',
    signInSso: 'Sign in with SSO',
    welcomeTitle: 'How can Piloti help with your project?',
    usePrompt: 'Use suggestion: {prompt}',
    prompt1: 'Compare OIB 2 fire resistance duties across building classes.',
    prompt2: 'Summarize accessibility requirements for a public retrofit.',
    prompt3: 'Find contradictions between uploaded plans and OIB guidance.',
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
    researchReport: 'Research report',
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
    overflowAria: '{count} more source types',
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
      countSessions: 'all {count} chats in this project',
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

  export: {
    availableWhenComplete: 'Export will be available when research is complete',
    exportReport: 'Export report',
    noContent: 'No content to export',
    asMarkdown: 'Export as Markdown',
    asMarkdownDisabled: 'Export as Markdown ({reason})',
    asPdf: 'Export as PDF',
    asPdfDisabled: 'Export as PDF ({reason})',
    generatingPdf: 'Generating PDF...',
    generating: 'Generating...',
    markdown: 'Markdown',
    pdf: 'PDF',
  },

  agentCard: {
    detailsWhenComplete: 'Details available when the agent completes',
    isRunning: '{name} is running',
    queriesCount: '{completed}/{total} queries',
    toolsCount: '{completed}/{total} tools',
    started: 'Started: {time}',
    running: 'Running',
  },

  agentsTab: {
    title: 'Agents',
    runningCount: '{count} running',
    queriesProgress: '{completed}/{total} queries',
    description: 'Active planner, researcher, and writer agents executing tasks.',
    empty: 'No agent activity available.',
  },

  fileCard: {
    lines: '{count} lines',
    content: 'Content',
  },

  fileSourceCard: {
    statusUploading: 'Uploading...',
    statusIngesting: 'Ingesting...',
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
    targetProject: 'Project corpus',
    targetSession: 'Private session',
    targetProjectLower: 'project corpus',
    targetSessionLower: 'private session',
    availableInProject: 'Available in this project.',
    preparingCorpus: 'Preparing project corpus...',
    onlyThisSession: 'Only available in this chat session.',
    loadingFiles: 'Loading files',
    checkingFiles: 'Checking for files...',
    setupBackend: 'Setup backend to enable files.',
    noAttachedFiles: 'No Attached Files',
    filesGoTo: 'Files uploaded here go to {target} unless removed.',
    filesCount: '{target} Files ({count})',
    loadingFilesEllipsis: 'Loading files...',
    addFiles: 'Add files',
    uploadNotAvailable: 'File upload not available',
    addFile: '+ Add File',
  },

  inputArea: {
    aiDisclosure:
      'Piloti is an AI — answers can be wrong; verify them against the cited Richtlinie.',
    placeholderDefault: 'Check data sources and ask a research question...',
    signInToStart: 'Sign in to start researching',
    researchCompletedNewSession: 'Research completed. Create a new session for further questions.',
    researchFailedFollowUp: 'Research didn’t finish. Ask a follow-up or try again.',
    typeResponse: 'Type your response to the agent...',
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
    researchCompletedAria: 'Research completed - create new session',
    researchCompleted: 'Research completed',
    researchCompletedPopover:
      'Research completed. For further questions or reports, please create a new session.',
    startNewSession: 'Start new session',
    researchInProgressAria: 'Research in progress - please wait',
    researchInProgress: 'Research in progress',
    researchInProgressPopover:
      'Research is currently in progress. Chat is paused to prevent generating multiple reports at the same time.',
    sendResponse: 'Send response',
    sendMessage: 'Send message',
    sendQuery: 'Send query',
    responseInput: 'Response input',
    chatMessageInput: 'Chat message input',
    stopStreaming: 'Stop response',
    sendWhilePending: 'Files are still processing — send anyway?',
    removeFile: 'Remove file: {name}',
    retryUpload: 'Retry upload',
    manageFiles: 'Manage files',
    manageFilesCount: 'Manage attached files ({count})',
    manageFilesMobile: 'Manage {count} files',
    openFile: 'Open file: {name}',
    fileUploadingStatus: 'Uploading',
    fileFailedStatus: 'Upload failed',
    fileReadyStatus: 'Ready',
  },

  reportCard: {
    reportWhenComplete: 'The report will appear here once research is complete.',
    exportAsMdPdf: 'You can export it as Markdown or PDF.',
    draft: 'Draft',
    words: '{count} words',
  },

  reportTab: {
    contentWhenAvailable: 'Report content will appear here when available.',
    notesBanner: 'Research notes from agents — final report is still being generated.',
    // Heading for the sources list appended from run citations when the
    // report markdown itself has no sources section.
    sourcesTitle: 'Sources',
    // Per-source origin badges: whether a cited source came from the trusted
    // knowledge base, the official Austrian legal system (RIS), or the web.
    sourceBadge: {
      kb: 'Knowledge Base',
      web: 'Web',
      ris: 'RIS',
    },
  },

  researchPanel: {
    closePanel: 'Close research panel',
    openPanel: 'Open research panel',
    signInToAccess: 'Sign in to access research panel',
    researching: 'Researching',
    tabTasks: 'Tasks',
    tabThinking: 'Thinking',
    tabReport: 'Report',
    stopResearchingButton: 'Stop Researching',
    stopResearching: 'Stop researching',
    // Confirmation dialog shown before cancelling a running deep-research job.
    stopConfirmTitle: 'Stop research?',
    stopConfirmBody:
      'The running research will be cancelled and cannot be resumed. Partial progress so far stays visible in the research panel.',
    stopConfirmConfirm: 'Stop research',
    noActiveResearch: 'No active research',
    loadingData: 'Loading research data',
    loadingDataEllipsis: 'Loading research data...',
    loadingReport: 'Loading report...',
    couldNotStop: 'Could not stop research',
    couldNotStopDesc: 'The research run may still be running. Please try again.',
  },

  sessionsPanel: {
    title: 'Chat history',
    /** Shown beside the title so the panel states its own size. */
    countLabel: '{count} chats',
    countLabelOne: '1 chat',
    // Storage is surfaced only once it is close enough to matter, and then it
    // says what to do about it rather than reporting a number.
    storageQuota: 'Browser storage is {percent}% full — delete old chats to free space.',
    storageNote:
      'Chats are saved in this browser. Research reports may expire on the server.',
    deleteAllDisabled: 'Delete all chats in this project (disabled)',
    deleteAll: 'Delete all chats in this project',
    cannotDeleteBusy: 'Cannot delete while operations are in progress',
    deleteAllButton: 'Delete all chats',
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
    reportExpired: 'Report expired',
    reportCompleted: 'Report ready',
    chatSession: 'Chat',
    sessionLabelBusy: 'Chat: {title} (processing in progress)',
    sessionLabel: 'Chat: {title}',
    /** Same row, plus the state its leading icon depicts. */
    sessionLabelWithStatus: 'Chat: {title} — {status}',
    // FB-10: Deep Research section folded into the sessions panel.
    deepResearchHeading: 'Deep Research ({count})',
    deepResearchChip: 'Deep Research',
    deepResearchRunLabel: 'Open deep research run: {label} — {status}',
    /** A run's state, in words — the icon alone made "failed" and "ready" look alike. */
    runStatus: {
      running: 'Running',
      completed: 'Report ready',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
  },

  taskCard: {
    statusComplete: 'complete',
    statusInProgress: 'in progress',
    statusPending: 'pending',
    statusStopped: 'stopped',
    inProgress: 'In progress',
    task: 'Task: {content}',
  },

  tasksTab: {
    title: 'Tasks',
    description: 'Research plan breakdown and progress during deep research.',
    empty: 'Research tasks will appear here.',
    emptyHelp: 'Shows the plan breakdown and progress during deep research.',
    progressAria: 'Task completion progress',
    // Coarse elapsed-time indicator for a live run (updates every 30s).
    elapsed: 'Running for {minutes} min',
    writingReport: 'Writing final report... This may take a few minutes.',
    stalledTitle: 'No progress updates for a while',
    stalledBody:
      'Research hasn’t sent an update recently. It may still be running — reconnect to resume the live stream.',
    connectionLostTitle: 'Connection to the research job lost',
    connectionLostBody:
      'We lost the live connection, but the job may still be running on the server. Reconnect to resume, or stop it from the toolbar above.',
    reconnect: 'Reconnect',
    // Outcome of a run followed here without a chat thread of its own (a
    // workflow run) — it has no thread banner to report the ending.
    attachedRunFinished: 'This run has finished. The report is in the Report tab.',
    attachedRunFailed: 'This run failed before it finished.',
    attachedRunStopped: 'This run was stopped before it finished.',
  },

  thinkingTab: {
    tabThoughts: 'Thoughts',
    tabAgents: 'Agents',
    tabTools: 'Tools',
    tabFiles: 'Files',
    tabRead: 'Read',
    tabReferenced: 'Referenced',
    referenced: 'Referenced',
    sourcesRead: 'Sources Read',
    referencedSub: 'Sources referenced in the final report.',
    readSub:
      'Sources discovered during research that were not referenced in the final report.',
    noReferenced: 'No referenced sources available.',
    noRead: 'No read sources available.',
  },

  thoughtCard: {
    detailsWhenComplete: 'Details available when generation completes',
    generating: 'Generating',
    via: 'via {workflow}',
    tokens: 'Tokens: {prompt} in / {completion} out',
    output: 'Output',
  },

  thoughtTracesTab: {
    title: 'Thought Traces',
    runningCount: '{count} running',
    description: 'LLM chain-of-thought reasoning and inference activity.',
    empty: 'No thought traces available.',
  },

  toolCallCard: {
    detailsWhenComplete: 'Details available when the tool call completes',
    isRunning: '{name} is running',
    via: 'via {workflow}',
    arguments: 'Arguments',
    result: 'Result',
    error: 'Error',
  },

  toolCallsTab: {
    title: 'Tool Calls',
    runningCount: '{count} running',
    description: 'Web searches, file operations, and other tool invocations.',
    empty: 'No tool calls available.',
  },

  sourceCard: {
    cited: 'Cited',
  },
}
