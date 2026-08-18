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
    // Marks a source the report actually cited (vs. merely discovered).
    cited: 'Cited',
    loadFailed: 'The source preview could not be loaded. Please try again.',
    // Bindingness note (how a RIS source binds the project) in the info popover.
    bindingLabel: 'Binding effect',
    // The German legal terms are kept even in the English UI — they are the
    // terms of art an Austrian architect works in, and translating "verbindlich
    // erklärt" to "declared binding" loses the phrase they would search for.
    binding: {
      bindend: 'Bindend',
      verbindlich_erklaert: 'Verbindlich erklärt',
      auslegend: 'Auslegend',
    },
    openExternal: 'Open in RIS',
    // Coarse source kind (ADR-0026) shown in the info popover. Preferred
    // over `origins` because the origin token is kb/ris/web only, so a
    // knowledge-base copy of a legal text reads as project material.
    kinds: {
      baurecht: 'Building law & guidelines',
      buero: 'Office archive',
      projekt: 'Project knowledge',
      web: 'Web source',
    },
    // Origin line in the info popover (no openable document).
    origins: {
      kb: 'Project knowledge',
      ris: 'Law & guidelines (RIS)',
      web: 'Web source',
    },
  },
  // Document grid: real project/Büroarchiv files the assistant surfaced as
  // clickable preview cards (the `document_grid` card / `surface_documents` tool).
  documentGrid: {
    // Count pill — singular/plural chosen in the component (no ICU in this i18n).
    countOne: '1 document',
    countOther: '{count} documents',
    forQuery: '“{query}”',
    // Provenance badge on a card.
    source: {
      projekt: 'Project',
      buero: 'Office',
    },
    // A surfaced file that no longer resolves to a live document row — an honest,
    // actionable card (the assistant referenced it; open the archive / project
    // files) rather than a silent dead tile.
    unresolvedHint: 'The assistant referenced this file.',
    openInArchive: 'Open in archive',
    openInFiles: 'Open in project files',
    // The resolve fetch failed — a retry affordance, not a permanent dead tile.
    loadError: 'Documents couldn’t be loaded.',
    retry: 'Try again',
    openAria: 'Open document: {label}',
    thisFile: 'This file',
    choose: 'Which file?',
    // Quiet receipt when the card opened exactly one file beside the chat.
    showing: 'Showing {label}',
  },
  // Composer (InputArea) control row — WS-3 click-dummy overhaul.
  composer: {
    placeholder: 'Ask Piloti about this project …',
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
    // Mobile-only cue: the source/scope labels collapse to icons on phones, so a
    // tiny one-line hint under the composer keeps the active source count legible.
    sourcesActiveMobile: '{count} sources active',
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
  // Example Austrian Baurecht questions on the empty chat state — clicking one
  // prefills the composer (does not auto-send) to break blank-page paralysis.
  examples: {
    label: 'Try asking',
    questions: {
      modelElements: 'How many external walls are on the ground floor?',
      modelRequirements: 'Which requirements can my model not answer yet?',
      fluchtweg: 'Escape route length per OIB-2?',
      barrierefreiheit: 'Accessibility in Vienna residential construction?',
      brandabschnitte: 'Fire compartments for building class 4?',
    },
  },
  // Empty-state lock chip + thread role tabs (click-dummy overhaul, WS-3).
  workspace: {
    private: 'Private workspace',
  },
  roles: {
    input: 'Input',
    result: 'Result',
    // Role tab for a conversational / clarifying reply (routing_decision =
    // 'meta': greetings, capability questions, clarifying Rückfragen) — marks
    // it visibly apart from a substantive Baurecht 'Result'.
    note: 'Note',
  },
  // "Belegt durch" provenance chip row under answers that carry source data.
  answerSources: {
    label: 'Sources',
    ariaLabel: 'Sources this answer is backed by',
    // Honest "Lücke" gap row: a substantive answer that cites nothing renders
    // this in the neutral --source-auto family instead of hiding its lack of
    // grounding (design language — first-class knowledge-gap treatment).
    gapLabel: 'Without source citation',
    gapAria: 'This answer cites no sources',
    // The consolidated list numbers each source the way the answer's inline
    // [N] markers do, and shows the cited page after the chip.
    sourceNumber: 'Source {number}',
    page: 'p. {page}',
    pages: 'pp. {pages}',
    // Citations the user can actually paste somewhere — per source (Fachtext)
    // and for the whole answer in the formats external tools ingest.
    copyCitation: 'Copy citation',
    copied: 'Copied',
    copyCitationAria: 'Copy citation for {label}',
    copyFailed: 'The citation could not be copied.',
    citeAll: 'Cite',
    citeAsLabel: 'Copy all sources as',
    formats: {
      quotes: { label: 'Quoted passages', hint: 'The cited sentences, as a list' },
      fachtext: { label: 'Citation text', hint: 'For a report or submission' },
      apa: { label: 'APA', hint: 'Formatted bibliography' },
      bibtex: { label: 'BibTeX (.bib)', hint: 'LaTeX, JabRef' },
      ris: { label: 'EndNote/Zotero (.ris)', hint: 'Reference managers' },
      'csl-json': { label: 'CSL-JSON', hint: 'Zotero, Word, pandoc' },
    },
    // Note under the sources row when citation verification dropped one or more
    // unverifiable citations (WP-A `citations_removed`).
    citationsRemoved: '{count} citation(s) removed (not verifiable)',
    citationsRemovedReasonsLabel: 'Reasons',
  },
  // Getting the answer OUT of the app — the paste into a report, a mail, a
  // submission. Two icon buttons in the answer's meta row; the second one only
  // exists when the turn actually resolved sources to write out.
  answerActions: {
    copy: 'Copy answer',
    copyWithSources: 'Copy answer with full source references',
    copied: 'Copied',
    copyFailed: 'The answer could not be copied.',
    // The heading the written-out source list is filed under. Mirrors the
    // heading answers write themselves, so a pasted answer reads the same way
    // whichever button produced it.
    sourcesHeading: 'Sources',
    untitledSource: 'Untitled source',
  },
  // Thread-header breadcrumb (project / session title) with inline rename.
  // The citation peek: what a Fundstelle IS, before you open it.
  citationPeek: {
    wholeDocument: 'Whole document',
    openAtPage: 'Open at this passage',
    copyLink: 'Copy link',
    copyLinkAria: 'Copy a link to this passage: {label}',
    markerAria: 'Source {number}: {label} — open preview',
    lociLabel: '{count} passages',
    lociAria: 'Passages in this document',
    lociPosition: '{index}/{count}',
    previousLocus: 'Previous passage',
    nextLocus: 'Next passage',
    retrievedOnly: 'Read',
  },
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
    conditionTree: {
      eyebrow: 'Condition tree',
      dependsOn: 'Depends on',
      applies: 'applies here',
      basis: 'Basis',
      // Lead-in over the outcome of the case that DOES apply to this project.
      appliesHere: 'For this project the following applies:',
      // Lead-in over any other case, in the subjunctive: the grammar itself
      // says this is a what-if, so a screenshot of the panel cannot be read
      // as this project's answer.
      previewLead: 'Under {condition} the following would apply:',
      // Same lead-in where no branch is marked as this project's: nothing is
      // being contrasted, so nothing is put in the subjunctive.
      caseLead: 'Under {condition} the following applies:',
      // Rides INSIDE the previewed panel, so it travels with a screenshot.
      previewNotice: 'For comparison only — this project is {condition}: {outcome}',
      backToActive: 'Back to {condition}',
      caseAria: 'Case {condition}',
    },
    askAbout: {
      chip: 'Ask about this',
      chipAria: 'Put a question about "{subject}" into the message box',
      missingWithDetail:
        '"{subject}" is missing a figure: {missing}. How can I supply it, and what applies until then?',
      missingOnly:
        '"{subject}" is missing a figure. Which figure is needed here, and where do I get it?',
    },
  },
  agentPrompt: {
    needsInput: 'Piloti needs your input',
    receivedInput: 'Piloti received your input',
    /**
     * Shown to a colleague in a shared thread instead of the buttons: the agent
     * asked one person, and the agent tier refuses an answer from anybody else, so
     * a button here would be offering a refusal. Without this line the card reads
     * as broken rather than as somebody else's turn.
     */
    awaitingOther: 'Piloti is waiting for {name}',
    awaitingSomeone: 'Piloti is waiting for another participant',
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
    // Transient "checking" state (FIX 3): shown while the reconnect recovery
    // fetch is in flight, so a turn that only LOOKS interrupted does not flash
    // the "lost" copy before we have confirmed the answer is really gone.
    recovering: 'Reconnecting',
    recoveringNotice: 'Reconnecting — checking for a finished answer …',
    done: 'Done',
    elapsedAria: 'Elapsed: {seconds} seconds',
    // Live one-liners describing what the assistant is doing right now, chosen
    // from the newest OPEN step that can be phrased for a reader. There is
    // deliberately no "show the step's own name" entry: an internal identifier
    // dressed up as a status is noise, so an unclassifiable step falls through
    // to the previous meaningful phrase, or to `working` above.
    activity: {
      understanding: 'Understanding your question …',
      planning: 'Planning the approach …',
      searchingWeb: 'Searching the web …',
      searchingKnowledge: 'Searching OIB knowledge …',
      searchingRis: 'Searching RIS (Austrian law) …',
      searchingSources: 'Searching your sources …',
      researching: 'Researching …',
      reading: 'Reading the results …',
      composing: 'Composing the answer …',
      // The legacy `use_skill` tool frame, which names the mechanism and not
      // the skill. Honest and unnamed rather than wrong and specific. There is
      // no named peer here on purpose: once the backend emits `skill:<id>`
      // events it authors that sentence itself, carrying the skill's title and
      // the difference between a skill the model chose and one the user asked
      // for — neither of which a template here could know.
      usingSkillUnnamed: 'Applying a skill …',
    },
    // ── Turn events: the words for what the backend REPORTED ──────────────
    //
    // The agent narrates itself with `status:<slot>` steps, and it narrates in
    // KEYS: a stable dotted id plus interpolation values. Everything a reader
    // sees is written here, in their locale. It used to be written in the
    // Python and shipped as a finished German sentence, which is how an
    // English-locale reader read German.
    //
    // A key with no entry here renders NOTHING — the live line falls back to
    // the previous meaningful phrase. Never the key, never an identifier.
    turnStatus: {
      // Corpus NAMES, because "im OIB-Wissen" is product copy with a German
      // preposition welded on, not a proper noun. The backend sends the id.
      // Each entry is the prepositional phrase the templates below slot in.
      corpus: {
        knowledge: 'the OIB knowledge base',
        ris: 'RIS (Austrian law)',
        web: 'the web',
        documents: 'your documents',
        ifc: 'the building model',
      },
      // Joins two corpora in one line. Grammar, so it lives here too.
      corpusJoin: ' and ',
      status: {
        // Which of the reader's OWN files are being read. One key per level
        // rather than one template with a slot: German needs the dative ("aus
        // dem Büroarchiv") and English needs no article, so the level's name
        // cannot be interpolated into one shared sentence. Every line names
        // the level the way the product names it to the reader — office
        // archive, project, conversation. There is no line for several at
        // once, because the collective noun for them is OURS, not theirs, so
        // `several` states plainly WHAT is being read.
        documents: {
          archiv: 'Reviewing documents from the office archive …',
          project: 'Reviewing documents from the project …',
          session: 'Reviewing documents from this conversation …',
          several: 'Reviewing your documents …',
        },
        // The routing DECISION, from a closed enum. The classifier's own
        // reason for it is free-text prose in whatever language the model
        // wrote, so it never appears here — it is quoted, attributed, in the
        // secondary `routing.line` row below.
        routing: {
          meta: 'A conversation — no research needed',
          outOfScope: 'Question outside the subject area',
          shallow: 'Preparing a quick lookup',
          deep: 'Preparing deep research',
        },
        // `{query}` is the reader's own words echoed back — never translated,
        // and clipped by the backend so the line still fits one narrow row.
        retrieval: {
          withQuery: 'Searching {corpus}: “{query}”',
          plain: 'Searching {corpus} …',
        },
        // Non-retrieval tools the user asked for by name. A tool with no entry
        // gets no line at all: its internal name is not a status.
        action: {
          remember: 'Saving the note …',
          card: 'Building the result card …',
        },
        citations: 'Checking the citations …',
        escalation: 'A quick lookup is not enough — starting deep research',
      },
    },
    // The one skill event a reader sees, keyed on WHO decided. Two sentences
    // rather than one with a swapped verb — that difference is not a word in
    // every language. `{skill}` is the office's authored `grid-title` and
    // travels verbatim: it is their name for their own method.
    skill: {
      activated: 'Applying the “{skill}” skill',
      forced: 'Applying the “{skill}” skill you asked for',
    },
    // Compact "what actually ran" chips in the Herleitung basis — one chip per
    // executed agent/tool, without the technical-steps opt-in.
    executedSteps: 'Ran:',
    stepName: {
      understanding: 'Classification',
      routing: 'Research path',
      webSearch: 'Web search',
      ris: 'RIS',
      corpus: 'OIB knowledge',
      assistant: 'Assistant',
      reading: 'Reading',
      // One chip per skill the turn actually applied. `{name}` is resolved by
      // the single label authority (features/skills/lib/skill-activity).
      skill: 'Skill: {name}',
      // The bare `use_skill` frame with no identifiable skill behind it.
      skillUnnamed: 'Skill',
    },
    // Reader-facing names for the nodes and tools the backend emits, used by
    // the opt-in technical panel. The names on the wire are internal ids
    // (`knowledge_search`) — and NAT also forwards LangChain span names, which
    // are CamelCase class names — so the panel resolves every row through this
    // map instead of title-casing whatever arrived. Entries that a chip already
    // names reuse `stepName.*` above: one node, one wording, everywhere.
    nodeName: {
      // The root frame that is open for the whole turn, not a step within it.
      workflow: 'Whole exchange',
      clarification: 'Clarifying question',
      deepResearch: 'Deep research',
      dataSources: 'Data sources',
      note: 'Note saved',
      card: 'Result card',
      documents: 'Document list',
      askUser: 'Question to you',
      model: 'Building model',
      measure: 'Model measurement',
      compliance: 'Compliance check',
      skillSelection: 'Skill selection',
      // A node this build has no name for. It keeps its row — the panel counts
      // its steps and each carries a timestamp, so dropping rows would make the
      // list disagree with the count and hide that something ran — but it says
      // only that something internal ran. The raw name is not a vocabulary a
      // reader can learn (unlike a `status:` slot, which is one and stays
      // verbatim on purpose); it is whatever the framework called that span.
      internal: 'Internal step',
    },
    showThinking: 'Show thinking ({count})',
    showThinkingSteps: 'Show thinking steps ({count})',
    herleitungSummary: 'Trace · {steps} steps · {sources} sources',
    // aria-label naming the reasoning graph as one region for screen readers.
    reasoningGraphLabel: 'Reasoning trace',
    stepsLabel: 'Thinking steps',
    stepsHeading: 'Intermediate steps',
    sourcesFanOut: 'Sources',
    hitCount: '{count} hits',
    hitCountOne: '1 hit',
    gapHit: 'Nothing found',
    // A document the research read but the answer never cited — a real
    // research outcome, not a gap.
    readNotUsed: 'read, not used',
    moreSources: '+{count} more',
    // The files hung on THIS message. The data sources toggled on in the
    // composer are availability, not activity, and are deliberately not listed
    // here — what ran is the `executedSteps` row above.
    attachedFiles: 'Attached files:',
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
    node: {
      framingTab: 'Framing',
      framingTitle: 'Question understood',
      framingQuestion: 'You asked: “{question}”',
      contextLabel: 'Context',
      sourcesTab: 'Sources',
      sourcesTitle: 'Sources examined',
      findingsTab: 'Assessment',
      // Reasoning-only detail in the assessment node: which source lanes
      // produced hits. NOT the answer's trust verdict (confidence/provenance) —
      // that lives once, on the answer card.
      findingsHits: 'Hits in: {lanes}',
      // The proof-of-work tally, stated where the fan converges: what was
      // actually read, before naming which strata it came from.
      findingsTally: '{hits} hits across {docs} documents',
      findingsTallyOne: '{hits} hits in 1 document',
      // While the turn streams there is no assessment yet, but the graph still
      // needs its converge point — otherwise the source columns dangle and the
      // shape jumps when the answer lands.
      findingsPendingTab: 'Assessment',
      findingsPending: 'Weighing the sources …',
      branchesTab: 'Next steps',
      branchesSub: 'Pick one option — the answer is assembled for your choice.',
    },
  },
  deepResearch: {
    stats: {
      tokens: 'text volume {count}',
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
    // Retry action on an errored answer (design language: "helpful message + retry").
    retry: 'Try again',
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
      'Your usage budget is used up, so new messages can’t be sent right now. You can review your own usage under Organization → Usage & budgets. Ask an organization admin to raise your limit.',
    adminMessage:
      'The usage budget is used up, so new messages can’t be sent right now. Raise the limits under Organization → Usage & budgets.',
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
    // What each level MEANS, shown in the tooltip so the reader can interpret the chip.
    levelMeanings: {
      high: 'High: the answer is directly grounded in the retrieved sources, which support it clearly and consistently.',
      medium: 'Medium: partially grounded — sources support parts, but a gap, an inference, or a minor ambiguity remains.',
      low: 'Low: sources are missing, conflicting, or clearly insufficient; the answer extrapolates from general knowledge.',
    },
    // Label introducing the model's own one-clause justification (verbatim).
    reasonLabel: "Assistant's reason",
    // Extra sentence appended to the tooltip explaining WHY the confidence was
    // capped, keyed by `answer_confidence_capped_reason` (WP-A, PB-9).
    cappedReasons: {
      ungrounded: 'Low confidence: answer not backed by sources.',
      quoteUnverified: 'Low confidence: a quote could not be verified verbatim against the source.',
      // The measurement backs the number, not the legal statement beside it —
      // so the mixed answer stays at "low" and the tooltip says why.
      normativeClaimUncited:
        'Low confidence: the measurements come from the model, but the normative claim about them is not backed by a source.',
      // Measured is not cited: the number is reproducible, but "high" stays
      // reserved for an answer with a verified citation.
      measurementOnly:
        'Medium confidence: the figure was measured on the model (with tolerance and method), but is not backed by a source.',
      // The source came from the conversation, not from this answer — so it
      // backs no more than a measurement does.
      citationFallback:
        'Medium confidence: the source shown was attached by the assistant, not cited by the answer itself.',
    },
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
    voteRecorded: 'Rating saved.',
    commentLabel: 'Anything else?',
    commentPlaceholder: 'Optional — tell us what went wrong',
    commentSubmit: 'Send note',
  },
  // Copy message button on user message bubbles
  copyMessage: {
    copy: 'Copy message',
    copied: 'Copied',
    failed: 'Message could not be copied',
  },
}
