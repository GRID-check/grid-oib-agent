/** chat namespace — populated during component i18n. */
export const chat = {
  actions: {
    dismiss: 'Dismiss',
  },
  cards: {
    aiGenerated:
      'AI-generated citation — check the excerpt against the primary source (OIB / RIS).',
  },
  agentPrompt: {
    needsInput: 'Agent needs your input',
    receivedInput: 'Agent received your input',
    approve: 'Approve',
    reject: 'Reject',
    approvePlan: 'Approve plan',
    rejectPlan: 'Reject plan',
    yourResponse: 'Your response:',
  },
  agentResponse: {
    viewProgress: 'View Progress',
    viewReport: 'View Report',
    loading: 'Loading...',
    loadingLabel: 'Loading',
    errorTitle: 'Error: {message}',
  },
  profilePatchCard: {
    accept: 'Accept',
    applying: 'Applying...',
    reject: 'Reject',
    accepted: 'Project brief updated.',
    rejected: 'Changes discarded.',
    noProject: 'Open this chat from a project to apply brief changes.',
    field: 'Field',
    before: 'Before',
    after: 'After',
    applyFailed: 'Failed to apply the change',
  },
  thinking: {
    inProgress: 'Thinking in progress',
    working: 'Working on a response...',
    waiting: 'Waiting for response',
    interrupted: 'Interrupted',
    done: 'Done',
    showThinking: 'Show thinking ({count})',
    showThinkingSteps: 'Show thinking steps ({count})',
    stepsLabel: 'Thinking steps',
    selectedDataSources: 'Selected Data Sources:',
    dataSource: {
      webSearch: 'Web Search',
      files: 'Files',
    },
  },
  deepResearch: {
    stats: {
      tokens: '{count} tokens',
      toolCalls: '{count} tool calls',
    },
    success: {
      heading: 'Report Completed!{stats}',
      subheading: 'Research has finished and a report is ready to view in the research panel.',
    },
    failure: {
      heading: 'Report Failed to Complete',
      subheading:
        'Something prevented the research report from completing. Check the thinking for details.',
    },
    cancelled: {
      heading: 'Research Cancelled',
      subheading:
        'Research was stopped by user. You can view any partial progress in the research panel.',
    },
    expired: {
      heading: 'Report Expired',
      subheading: 'The report has expired and is no longer available.',
    },
    starting: {
      heading: 'Starting Deep Research',
      subheading:
        'Chat is paused while the report is created to prevent generating multiple reports. You can click away while this runs — it may take several minutes.',
    },
    viewReport: 'View Report',
    viewThinking: 'View Thinking',
    viewProgress: 'View Progress',
  },
  error: {
    showDetails: 'Show details',
    hideDetails: 'Hide details',
  },
  fileUpload: {
    uploading:
      'File is uploading and ingesting. Until completion, a file cannot be included in queries.',
    pendingWarning:
      'Files are pending! Wait until they are ready or send your query again to continue WITHOUT those files.',
  },
  noSources: {
    warning:
      'No data sources selected and no files are available. Responses are more likely to be inaccurate or outdated unless external data sources are added.',
  },
  memory: {
    noted: 'Grid noted',
    notedAria: 'Grid noted {count} items',
    addedToMemory: 'Added to project memory',
    manageHint: 'You can manage and delete these entries in the project memory.',
    kinds: {
      decision: 'Decision',
      constraint: 'Constraint',
      open_question: 'Open question',
      derived_fact: 'Fact',
      preference: 'Preference',
    },
    provenance: {
      distillation: 'added after the response',
      inTurn: 'noted during the response',
    },
  },
}
