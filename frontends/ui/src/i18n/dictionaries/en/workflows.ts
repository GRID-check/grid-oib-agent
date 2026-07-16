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
    empty: {
      title: 'No workflows yet',
      description:
        'Create a workflow to save a research brief you want to run again — manually or on a recurring schedule.',
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
    sourcesHint: 'Limit which sources the agent may use. Leave all unchecked to allow every available source.',
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
}
