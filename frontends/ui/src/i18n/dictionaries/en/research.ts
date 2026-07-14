/** The research workspace: chat shell, panels, and deep-research detail views. */
export const research = {
  dismissError: 'Dismiss error',

  // Shared empty-state helper shown across the deep-research detail tabs
  // (Thinking, Thought Traces, Tool Calls, Agents, Files).
  detailsHelp:
    'These details appear during active research and may not be available for completed reports.',

  runsPage: {
    title: 'Research runs',
    subtitle: 'Deep research reports Grid has produced for this project, newest first.',
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
    secureWorkspace: 'secure workspace',
    loggedOutTitle: 'Grid opens after your organization is verified.',
    loggedOutBody:
      'Sign in to unlock project-scoped OIB research, document ingestion, and member access controls.',
    signInSso: 'Sign in with SSO',
    featureWorkos: 'WorkOS authentication',
    featureRetrieval: 'Project-scoped retrieval',
    featureRbac: 'Role-based access',
    cockpit: 'OIB research cockpit',
    title: 'Start with a project, then ask for cited building-code reasoning.',
    body: 'Grid keeps retrieval scoped to the selected workspace and turns long guideline documents into traceable decisions.',
    reviewBrief: 'Review the brief',
    reviewBriefDesc: 'Open the project overview to check the facts Grid uses for tailored answers.',
    uploadFiles: 'Upload files',
    uploadFilesDesc: 'Attach plans or documents with the paperclip to ground answers in your evidence.',
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
    toggleSessions: 'Toggle sessions sidebar',
    signInToView: 'Sign in to view sessions',
    sessions: 'Sessions',
    addSources: 'Add data sources',
    signInToManage: 'Sign in to manage data sources',
    sources: 'Sources',
    research: 'Research',
  },

  dataSources: {
    loading: 'Loading data sources',
    loadingEllipsis: 'Loading data sources...',
    unableToLoad: 'Unable to load data sources',
    retryAria: 'Retry loading data sources',
    none: 'No data sources available',
    changesDisabledBusy: 'Data source changes disabled during active operations',
  },

  dataConnectionCard: {
    enabled: 'enabled',
    disabled: 'disabled',
    disabledParenthetical: '(disabled)',
    noPermission: "You don't have permission to access this data source",
    enableName: 'Enable {name}',
    disableName: 'Disable {name}',
    nameDisabled: '{name} (disabled)',
  },

  dataConnectionsTab: {
    availableSources: 'Available Sources ({count})',
  },

  dataSourcesPanel: {
    title: 'Data Sources',
    footerConnections:
      '{enabled} of {available} available connections enabled. Enabled connections will be available to the AI assistant.',
    footerFiles: 'Attached files will be always available to agents until deleted.',
    tabConnections: 'Connections',
    tabFiles: 'Files',
    enableAuthBanner: 'Enable authentication to access additional data sources.',
    signInBanner: 'Sign in to access additional data sources.',
    allConnections: 'All Connections',
    allAvailableDisabledOps: 'All available connections (disabled during operations)',
    allAvailableState: 'All available connections: {state}',
    disableEnableAll: 'Disable / Enable All',
    toggleAllDisabled: 'Toggle all connections (disabled)',
    disableAll: 'Disable all connections',
    enableAll: 'Enable all connections',
    individualConnections: 'Individual Connections ({count})',
    signInRequiredSource: 'Sign in required to access this data source',
  },

  deleteModals: {
    cannotReverse: 'This action cannot be reversed. Are you sure you want to do this?',
    aboutToDelete: 'You are about to delete',
    lossSuffix: '. You will lose all progress and any files you have attached will be removed.',
    all: {
      title: 'Deleting All Sessions in This Project',
      countSessions: 'all {count} sessions in this project',
      allSessions: 'ALL sessions in this project',
      scopeNote: 'Only sessions in this project are deleted. Your sessions in other projects are not affected.',
      confirm: 'Delete Project Sessions',
    },
    file: {
      title: 'Delete File',
      thisFile: 'this file',
      suffix: '. This will completely remove it from your session.',
      confirm: 'Delete File',
    },
    session: {
      title: 'Deleting Session',
      thisSession: 'this session',
      confirm: 'Delete Session',
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
      'Grid is an AI system. Answers are AI-generated and can be wrong — verify them against the cited guideline (Richtlinie) before relying on them.',
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
    toggleDataSources: 'Toggle data sources connections',
    selectedConnections: 'Selected data connections',
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
    researchInProgressAria: 'Research in progress - please wait',
    researchInProgress: 'Research in progress',
    researchInProgressPopover:
      'Research is currently in progress. Chat is paused to prevent generating multiple reports at the same time.',
    sendResponse: 'Send response',
    sendMessage: 'Send message',
    sendQuery: 'Send query',
    responseInput: 'Response input',
    chatMessageInput: 'Chat message input',
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
    title: 'Sessions',
    storageQuota: 'Using {percent}% of browser storage quota',
    storageNote:
      'Note: Chat sessions are saved in this browser. Research reports may expire on the server.',
    deleteAllDisabled: 'Delete all sessions in this project (disabled)',
    deleteAll: 'Delete all sessions in this project',
    cannotDeleteBusy: 'Cannot delete while operations are in progress',
    deleteAllButton: 'Delete All',
    newSessionDisabled: 'Start new session (disabled during active operations)',
    startNewSession: 'Start new session',
    cannotCreateActive: 'Cannot create new session while current session is active',
    newSessionButton: 'New Session',
    searchPlaceholder: 'Search sessions...',
    searchAria: 'Search sessions',
    noMatching: 'No matching sessions',
    noMatchingDescription: 'No sessions match your search. Try a different term.',
    noSessions: 'No sessions yet',
    noSessionsDescription: 'Start a new session to begin researching with Grid.',
    startNewSessionButton: 'Start a new session',
    today: 'Today',
    yesterday: 'Yesterday',
    editTitle: 'Edit session title',
    renameDisabled: 'Rename session (disabled)',
    rename: 'Rename session',
    cannotRenameBusy: 'Cannot rename while operations are in progress',
    deleteDisabled: 'Delete session (disabled)',
    deleteSession: 'Delete session',
    sessionActive: 'Session active',
    reportExpired: 'Report expired',
    reportCompleted: 'Report completed',
    chatSession: 'Chat session',
    sessionLabelBusy: 'Session: {title} (processing in progress)',
    sessionLabel: 'Session: {title}',
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
