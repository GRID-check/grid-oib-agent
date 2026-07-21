/** chat namespace — populated during component i18n. */
export const chat = {
  actions: {
    dismiss: 'Dismiss',
  },
  // Source preview (WS-9, FB-4): citation chips open a preview of the source.
  sourcePreview: {
    chipAria: 'Preview source: {label}',
    view: 'View',
    // Document-type chip in the preview dialog header.
    projectDocument: 'Project document',
    corpusDocument: 'Building law & guidelines',
    // Tinted box with the passage the answer cites.
    citedPassage: 'Cited passage',
    loadFailed: 'The source preview could not be loaded. Please try again.',
    // Bindingness note (how a RIS source binds the project) in the info popover.
    bindingLabel: 'Binding effect',
    openExternal: 'Open in RIS',
    // Origin line in the info popover (no openable document).
    origins: {
      kb: 'Project knowledge',
      ris: 'Law & guidelines (RIS)',
      web: 'Web source',
    },
  },
  // Composer (InputArea) control row — WS-3 click-dummy overhaul.
  composer: {
    placeholder:
      'Describe what you are working on — Piloti shows you, step by step, what is relevant …',
    sources: 'Data basis',
    sourcesAria: 'Data basis — {enabled} of {total} sources enabled. Opens the data sources panel.',
    deepResearch: 'Deep Research',
    deepResearchAria: 'Deep Research preference',
    // Honest intent hint: the agent auto-escalates; the pill records a
    // preference, it does not force a deep-research run.
    deepResearchHint:
      'Preference noted — Piloti escalates to Deep Research automatically when a question calls for it.',
    scopeAria: 'Search scope: {project}',
    scopeFallback: 'This project',
    scopeCurrent: 'Current project',
    scopeAll: 'All projects',
    scopeAllSoon: 'Coming soon — cross-project search is not available yet.',
  },
  // Source-preset shortcut chips under the composer (empty thread).
  shortcuts: {
    label: 'Shortcuts',
    presetAria: 'Source preset: {label}',
    presets: {
      law: 'Building law & guidelines',
      project: 'Project documents',
      office: 'Office archive',
    },
  },
  // Time-of-day greeting on the empty chat state.
  greeting: {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    withName: '{greeting}, {name}.',
    subtitle: 'Ask about your project — answers cite their sources.',
  },
  // Empty-state lock chip + thread role tabs (click-dummy overhaul, WS-3).
  workspace: {
    private: 'Private workspace',
  },
  roles: {
    input: 'Input',
    result: 'Result',
  },
  // "Belegt durch" provenance chip row under answers that carry source data.
  answerSources: {
    label: 'Sources',
    ariaLabel: 'Sources this answer is backed by',
    // Note under the sources row when citation verification dropped one or more
    // unverifiable citations (WP-A `citations_removed`).
    citationsRemoved: '{count} citation(s) removed (not verifiable)',
    citationsRemovedReasonsLabel: 'Reasons',
  },
  // Thread-header breadcrumb (project / session title) with inline rename.
  breadcrumb: {
    ariaLabel: 'Conversation breadcrumb',
    renameAria: 'Rename session — click to edit the title',
    renameInputAria: 'Session title',
  },
  cards: {
    legalBasis: 'Legal basis',
    viewOib: 'View OIB Richtlinie',
    verifyRis: 'Verify in RIS',
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
    selectOption: 'Select option: {option}',
    yourResponse: 'Your response:',
    // Localized replacement for the backend's English approval envelope
    // sentence ("Reply approve to proceed, reject to cancel").
    approvalInstruction: 'Choose "Approve" to start the research or "Reject" to cancel.',
    // Duration/cost expectation shown at the decision point, BEFORE approval.
    durationHint:
      'Deep research can take several minutes to run and consumes usage quota.',
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
  memoryProposal: {
    title: 'Save this finding to memory?',
    prompt: 'Do you want to remember this org-wide?',
    yes: 'Yes, remember org-wide',
    no: 'No',
    saving: 'Saving…',
    saveToProject: 'Save to just this project',
    savedOrg: 'Saved to organization memory (org-wide).',
    savedProject: 'Saved to this project’s memory.',
    dismissed: 'Not saved.',
    error: 'Could not save the finding',
    kind: {
      decision: 'Decision',
      constraint: 'Constraint',
      open_question: 'Open question',
      derived_fact: 'Derived fact',
      preference: 'Preference',
    },
  },
  thinking: {
    inProgress: 'Thinking in progress',
    working: 'Working on a response …',
    waiting: 'Waiting for response',
    interrupted: 'Interrupted',
    // Compact inline notice on an interrupted turn: a silent reconnect can drop
    // an in-flight answer (protocol-robustness item 4). German copy is the
    // product-facing string; this English fallback is for harnesses/tests.
    interruptedNotice: 'Connection briefly lost — the answer was dropped. Please resend.',
    done: 'Done',
    elapsedAria: 'Elapsed: {seconds} seconds',
    // Live one-liners describing what the assistant is doing right now, chosen
    // from the newest streamed step. `runningNamed` is the honest fallback for
    // a step we can't classify — it shows the step's own name.
    activity: {
      understanding: 'Understanding your question …',
      planning: 'Planning the approach …',
      searchingWeb: 'Searching the web …',
      searchingSources: 'Searching your sources …',
      researching: 'Researching …',
      reading: 'Reading the results …',
      composing: 'Composing the answer …',
      runningNamed: '{name} …',
    },
    showThinking: 'Show thinking ({count})',
    showThinkingSteps: 'Show thinking steps ({count})',
    herleitungSummary: 'Trace · {steps} steps · {sources} sources',
    stepsLabel: 'Thinking steps',
    stepsHeading: 'Intermediate steps',
    sourcesFanOut: 'Sources',
    hitCount: '{count} hits',
    gapHit: 'Not in corpus',
    moreSources: '+{count} more',
    selectedDataSources: 'Selected Data Sources:',
    // "Why this path?" — the routing classification for this turn (WP-A
    // `routing_decision` + `routing_reason`), in the trace framing node.
    routing: {
      whyLabel: 'Why this path?',
      line: 'Classification: {decision} — {reason}',
      decision: {
        meta: 'Direct answer',
        shallow: 'Quick research',
        deep: 'Deep research',
        error: 'Error',
      },
    },
    // One-liner when this turn escalated from shallow to deep research.
    escalationNarration: 'Escalated to deep research: {reason}',
    dataSource: {
      webSearch: 'Web Search',
      knowledgeBase: 'OIB Knowledge Base',
      ris: 'RIS (Austrian Law)',
    },
    node: {
      framingTab: 'Intermediate step',
      framingTitle: 'Question understood',
      framingQuestion: 'You asked: “{question}”',
      contextLabel: 'Context',
      sourcesTab: 'Sources',
      sourcesTitle: 'Sources examined',
      findingsTab: 'Assessment',
      findingsTitle: 'Backed by',
      confidenceLabel: 'Confidence',
      confidence: {
        high: 'Well supported',
        medium: 'Partly supported',
        low: 'Weakly supported',
      },
      branchesTab: 'Next steps',
      branchesTitle: 'How do you want to proceed?',
      branchesSub: 'Pick one option — the answer is assembled for your choice.',
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
    // One-liner above the "Starting Deep Research" banner when the turn
    // escalated from shallow to deep research (WP-A `escalation_reason`).
    escalationNarration: 'Escalated to deep research: {reason}',
  },
  error: {
    showDetails: 'Show details',
    hideDetails: 'Hide details',
  },
  // Localized titles + default messages for the chat error registry
  // (features/chat/lib/error-registry.ts). Keyed by error code.
  errorRegistry: {
    connectionLost: {
      title: 'Connection Lost',
      message: 'Lost connection to the server. Please check your network.',
    },
    connectionFailed: {
      title: 'Connection Failed',
      message: 'Unable to connect to the server. Please check your network connection.',
    },
    connectionTimeout: {
      title: 'Request Timeout',
      message: 'The request took too long to complete.',
    },
    sessionExpired: {
      title: 'Session Expired',
      message: 'Your session has expired. Please sign in again.',
    },
    unauthorized: {
      title: 'Unauthorized',
      message: 'You do not have permission to perform this action.',
    },
    responseFailed: {
      title: 'Response Failed',
      message: 'The assistant encountered an error generating a response.',
    },
    responseInterrupted: {
      title: 'Response Interrupted',
      message: 'Your previous request was not completed. Please resend your message.',
    },
    workflowError: {
      title: 'Request Failed',
      message:
        'The assistant hit an unexpected error while handling your request. Please try again.',
    },
    deepResearchFailed: {
      title: 'Deep Research Failed',
      message: 'The deep research process encountered an error.',
    },
    deepResearchLoadFailed: {
      title: 'Research Data Unavailable',
      message: 'Unable to load research data. The job may have expired or been deleted.',
    },
    unknown: {
      title: 'Something Went Wrong',
      message: 'An unexpected error occurred. Please try again.',
    },
    // Deep-research job rejected because the queue is full (WP-A
    // `job_admission_rejected`). Warning, not error: resending resolves it.
    researchQueueFull: {
      title: 'Research is busy',
      message: 'The research queue is currently full. Please resend your request in a moment.',
      retryHint: 'Please try again in about {seconds} seconds.',
    },
  },
  // User-facing deep-research error copy raised from the SSE hook and the
  // job-data loading hook (use-load-job-data.ts).
  deepResearchErrors: {
    interrupted: 'Research was interrupted before completion.',
    reportUnavailable: 'This research report is no longer available.',
    serviceUnreachable: 'The service is currently unreachable. Please try again later.',
    jobStillRunning:
      'This research is still running. The report can be opened once it finishes.',
    loadFailed: 'Research data could not be loaded.',
  },
  // Toasts fired when a session is deleted but its deep-research job could not
  // be cancelled on the server.
  sessionActions: {
    researchMayStillRunTitle: 'Research run may still be running',
    researchMayStillRunDescription:
      'The session was deleted, but its deep-research job could not be stopped on the server.',
    researchRunsMayStillRunTitle: '{count} research {runLabel} may still be running',
    researchRunsMayStillRunDescription:
      'Sessions were deleted, but some deep-research jobs could not be stopped on the server.',
    runSingular: 'run',
    runPlural: 'runs',
  },
  budgetExhausted: {
    title: 'Budget exhausted',
    memberMessage:
      'Your LLM budget is used up, so new messages can’t be sent right now. You can review your own usage under Organization → Usage & budgets. Ask an organization admin to raise your limit.',
    adminMessage:
      'The LLM budget is used up, so new messages can’t be sent right now. Raise the limits under Organization → Usage & budgets.',
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
    noted: 'Piloti noted',
    notedAria: 'Piloti noted {count} items',
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
  confidence: {
    label: 'Confidence: {level}',
    levels: {
      high: 'high',
      medium: 'medium',
      low: 'low',
    },
    ariaLabel: 'Assistant self-assessed confidence: {level}',
    tooltip:
      "The assistant's own assessment of how well this answer is supported by its sources. It can be wrong.",
    // Extra sentence when the confidence was capped because the answer is not
    // grounded in verified citations (WP-A `answer_confidence_capped_reason`).
    cappedUngrounded:
      'The confidence was capped because the answer is not grounded in verified citations.',
  },
  // Per-answer thumbs feedback (WS-7, `answer-feedback` flag).
  feedback: {
    question: 'Was this helpful?',
    helpfulAria: 'Mark this answer as helpful',
    notHelpfulAria: 'Mark this answer as not helpful',
    reasonPrompt: 'What was the problem?',
    reasons: {
      inaccurate: 'Inaccurate',
      too_slow: 'Too slow',
      wrong_source: 'Wrong source',
      other: 'Other',
    },
    thanks: 'Thanks for your feedback.',
  },
}
