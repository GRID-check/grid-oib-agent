/** Workflows: saved research briefs run manually or on a cron schedule. */
export const workflows = {
  title: 'Workflows',
  subtitle:
    'Saved research briefs for this project. Run them on demand or on a schedule — each run goes through the same deep-research pipeline as a chat request.',
  newWorkflow: 'New workflow',
  backToList: 'Back to workflows',
  loadError: 'The workflows could not be loaded.',
  tryAgain: 'Try again',

  list: {
    heading: 'Your workflows',
    empty: {
      title: 'No workflows yet',
      description:
        'Set up a template above or create a workflow from scratch to save a research brief you want to run again — manually or on a recurring schedule.',
      action: 'New workflow',
    },
    manualOnly: 'Manual only',
    nextRun: 'Next run {time}',
    lastRun: 'Last run {time}',
    neverRun: 'Never run',
    disabled: 'Disabled',
    enableAria: 'Enable workflow “{name}”',
    disableAria: 'Disable workflow “{name}”',
    toggleError: 'The workflow could not be updated.',
  },

  actions: {
    edit: 'Edit',
    runNow: 'Run now',
    running: 'Running…',
    delete: 'Delete',
    history: 'Run history',
  },

  schedule: {
    presets: {
      hourly: 'Every hour',
      daily: 'Daily at 06:00',
      weekly: 'Weekly, Monday 06:00',
      monthly: 'Monthly, 1st at 06:00',
      custom: 'Custom schedule',
    },
    // Humanized summary shown on the list card, appended with the timezone.
    summaryHourly: 'Hourly',
    summaryDaily: 'Daily at 06:00',
    summaryWeekly: 'Weekly on Monday at 06:00',
    summaryMonthly: 'Monthly on the 1st at 06:00',
    summaryCustom: 'Custom ({cron})',
    inTimezone: '{summary} · {timezone}',
  },

  run: {
    submitted: 'Run started.',
    submittedDetail: 'Follow it in the Research tab.',
    skipped: 'Run skipped',
    error: 'The run could not be started.',
    disabled: 'Enable the workflow before running it.',
  },

  deleteDialog: {
    title: 'Delete workflow',
    description: 'This permanently deletes “{name}” and its run history. This cannot be undone.',
    confirm: 'Delete workflow',
    cancel: 'Cancel',
    error: 'The workflow could not be deleted.',
  },

  builder: {
    createTitle: 'New workflow',
    editTitle: 'Edit workflow',
    createSubtitle: 'Describe the research brief. The preview shows exactly what the agent receives.',
    editSubtitle: 'Adjust the brief or schedule. The preview shows exactly what the agent receives.',

    detailsSection: 'Details',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Weekly OIB fire-safety scan',
    nameRequired: 'A name is required.',
    nameTooLong: 'The name is too long (max 200 characters).',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'Optional — a short note about what this workflow is for.',

    briefSection: 'Research brief',
    objectiveLabel: 'Objective',
    objectivePlaceholder: 'What should the agent research? e.g. “Summarize recent changes to OIB-Richtlinie 2.”',
    objectiveRequired: 'An objective is required.',
    contextLabel: 'Context',
    contextPlaceholder: 'Optional background the agent should assume — the project, prior findings, constraints.',
    questionsLabel: 'Research questions',
    questionsHint: 'Optional specific questions the report should answer.',
    questionPlaceholder: 'Research question',
    addQuestion: 'Add question',
    removeQuestion: 'Remove question',
    outputFormatLabel: 'Output format',
    outputFormatPlaceholder: 'Optional — e.g. “executive summary plus a table of sources.”',
    compiledTooLong: 'The compiled brief is too long (max 32,000 characters). Shorten the sections.',

    sourcesSection: 'Data sources',
    knowledgeAlways: 'Project documents & OIB knowledge base — always included in every run',
    additionalSourcesLabel: 'Additional sources',
    sourcesHint: 'Add sources beyond the knowledge base. Leave all unchecked to allow every available additional source.',
    sourcesAll: 'All available sources',
    sourcesLoading: 'Loading sources…',
    sourcesError: 'Sources could not be loaded — the workflow will use all available sources.',

    scheduleSection: 'Schedule',
    enableScheduleLabel: 'Run on a schedule',
    enableScheduleHint: 'When off, the workflow only runs when you press “Run now”.',
    presetLabel: 'Frequency',
    cronLabel: 'Cron expression',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Five fields: minute hour day-of-month month day-of-week.',
    cronInvalid: 'Enter a valid 5-field cron expression.',
    timezoneLabel: 'Timezone',

    enabledLabel: 'Enabled',
    enabledHint: 'A disabled workflow never fires on schedule and cannot be run manually.',

    save: 'Save workflow',
    saving: 'Saving…',
    cancel: 'Cancel',
    createSuccess: 'Workflow created.',
    updateSuccess: 'Workflow saved.',
    saveError: 'The workflow could not be saved.',

    preview: {
      title: 'What the agent receives',
      subtitle: 'Compiled from the brief above. The server compiles this same output at save time.',
      empty: 'Fill in the objective to see the compiled brief.',
    },
  },

  history: {
    title: 'Run history',
    loading: 'Loading runs…',
    loadError: 'The run history could not be loaded.',
    empty: 'This workflow has not run yet.',
    viewReport: 'View report',
    scheduler: 'Scheduler',
    trigger: {
      manual: 'Manual',
      schedule: 'Scheduled',
    },
    status: {
      submitted: 'Submitted',
      skipped: 'Skipped',
      error: 'Error',
    },
  },

  // Piloti-authored default templates — the always-visible gallery at the top of
  // the Workflows page. Selecting a card pre-fills the builder; templates never
  // auto-create or run a workflow (the user reviews and saves).
  templates: {
    badge: 'By Piloti',
    heading: 'Piloti templates',
    hint: 'Prefilled research briefs — review, adjust and save. Nothing runs until you save the workflow.',
    setUp: 'Set up',
    setUpAria: 'Set up template “{name}”',
    // Honest cadence hints derived from the template's real cron.
    cadence: {
      manual: 'On demand',
      hourly: 'Runs hourly',
      daily: 'Runs daily',
      weekly: 'Runs weekly',
      monthly: 'Runs monthly',
      custom: 'Custom schedule ({cron})',
    },
    moreComing: {
      title: 'More coming',
      hint: 'Further Piloti templates will appear here.',
    },

    submissionPrecheck: {
      name: 'Submission pre-check',
      description:
        "Researches which requirements apply to this project's permit submission (state building code, OIB Richtlinien) and reports open points and missing evidence in a deep-research report.",
      objective:
        "Determine the requirements this project's permit submission (Einreichung) must satisfy — under the applicable state building code (Bauordnung) and the OIB Richtlinien — and report which points the project documentation already covers and which remain open.",
      context:
        "Use the project's documents to establish what is planned and what has already been prepared (drawings, reports, evidence). Use the OIB knowledge base and RIS (the Bauordnung and related ordinances of the project's Bundesland) as the normative basis. This is a preparatory research report for the planning team — it does not replace the authority's formal review of the submission.",
      outputFormat:
        'A checklist grouped by topic: requirement, legal basis (exact citation), status (covered / open / unclear), reference to the project document, recommended action. Close with a short summary of the biggest open points. Cite every requirement with its source.',
      questions: {
        q1: 'Which authority requirements and which submission documents (Einreichunterlagen) does the applicable state building code demand for this project type and location?',
        q2: 'Which OIB requirements must the submission demonstrably address for this building class and use?',
        q3: 'Which of these points does the current project documentation already cover? Cite the document.',
        q4: 'Which points are open — missing documents, missing evidence, or unresolved contradictions?',
        q5: 'What should the planning team prioritize before submitting, and are formal deviations (Abweichungen) foreseeable?',
      },
    },

    regulatoryWatch: {
      name: 'Regulatory watch: OIB & Austrian building law',
      description:
        'Weekly scan of RIS and the web for changed laws, ordinances, case law and OIB guideline releases that affect this project — with a concrete impact assessment.',
      objective:
        'Identify changes to Austrian building law and the OIB Richtlinien that are relevant to this project — new or amended federal and state laws and ordinances (RIS), new OIB guideline releases or drafts, and relevant case law — and assess their concrete impact on this project.',
      context:
        "Work from this project's documents to understand its scope (building type, location/Bundesland, permit status, current planning stage). Prioritize primary sources: RIS for federal and state law (including Bauordnungen and Bautechnikgesetze/-verordnungen) and case law; official OIB publications for guideline releases; use web search only for announcements, drafts and expert commentary. Focus on developments from the last 30 days, plus anything older that has an upcoming transition deadline.",
      outputFormat:
        'Start with an executive summary of at most half a page. Then a table of changes: source (with exact RIS/OIB citation), date, what changed, impact on this project (high/medium/low), recommended action, deadline. Close with open questions for the planning team. Cite every claim with its source.',
      questions: {
        q1: 'Which laws, ordinances or OIB guidelines relevant to this project have changed recently, or have announced upcoming changes?',
        q2: 'What exactly changed compared to the previous legal situation?',
        q3: 'Which parts of this project (design, permits, documentation) are affected, and how severely?',
        q4: 'Which deadlines or transition periods (Übergangsfristen) apply?',
        q5: 'What concrete actions should the planning team take, and how urgent is each one?',
      },
    },

    complianceGapCheck: {
      name: 'OIB compliance gap check',
      description:
        'Cross-checks the project documentation against the applicable OIB Richtlinien and returns a prioritized list of gaps, contradictions and missing evidence.',
      objective:
        "Systematically cross-check this project's current documentation against the applicable requirements of the OIB Richtlinien (1–6) and identify compliance gaps, contradictions and missing evidence.",
      context:
        "Use the project's uploaded documents as the factual basis for what is planned, and the OIB knowledge base as the normative basis. First determine which OIB Richtlinien and which requirement classes apply to this building type, use and location. Where the project documentation is silent on an applicable requirement, treat it as missing evidence — not as compliant. Note where a planned solution deviates from an OIB requirement and would require a formal deviation (Abweichung) under the applicable state building code, including possible compensating measures.",
      outputFormat:
        'A compliance matrix grouped by OIB Richtlinie: requirement, status (compliant / gap / missing evidence / deviation), evidence citation, comment. Then a risk-ranked gap list with recommended next steps, and open questions for the planning team. Cite OIB clauses and project documents precisely.',
      questions: {
        q1: 'Which OIB Richtlinien and which specific requirements apply to this project (building class, use, location)?',
        q2: 'For each applicable requirement: where does the project documentation demonstrate compliance? Cite the document and passage.',
        q3: 'Which applicable requirements have no supporting evidence in the documentation, or contradictory statements across documents?',
        q4: 'Which planned solutions deviate from OIB requirements and would need a formal Abweichungsantrag or compensating measures?',
        q5: 'Which gaps carry the highest risk and should be resolved before the next permit milestone?',
      },
    },
  },
}
