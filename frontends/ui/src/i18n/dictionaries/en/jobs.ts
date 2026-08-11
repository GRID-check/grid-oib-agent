/**
 * Jobs — a prompt on a timer.
 *
 * A job fires its prompt into a fresh run the way a person opening a new chat
 * and typing would. A skill MAY be attached on top, exactly as typing `/name`
 * before the message would attach it — the empty state (no skill) is the
 * common case, and the copy below says so. The skill toolbox itself lives in
 * the `skills` namespace; nothing here is about authoring skills.
 */
export const jobs = {
  title: 'Jobs',
  subtitle:
    'Prompts this project runs on a timer. A job sends its prompt exactly as if you had typed it into a new chat — optionally with a skill attached — and you choose what comes back: a chat, or a report.',
  backToList: 'Back to jobs',
  loadError: 'The jobs could not be loaded.',
  tryAgain: 'Try again',

  list: {
    heading: 'Jobs',
    empty: {
      title: 'No jobs yet',
      description:
        'A job is a prompt on a timer. Write the prompt once, choose whether it produces a chat or a report, and let it run — on demand or on a recurring schedule.',
      action: 'New job',
    },
    manualOnly: 'Manual only',
    nextRun: 'Next run {time}',
    lastRun: 'Last run {time}',
    neverRun: 'Never run',
    disabled: 'Disabled',
    enableAria: 'Enable job “{name}”',
    disableAria: 'Disable job “{name}”',
    toggleError: 'The job could not be updated.',
    /** The job's own prompt, shown on the card so the row says what it sends. */
    promptLabel: 'Prompt',
    withSkill: 'Skill: {name}',
    noSkill: 'No skill',
    output: {
      chat: 'Chat',
      'deep-research': 'Report',
    },
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
    submittedDetail: 'It is running now — follow it live from the run history.',
    viewProgress: 'View progress',
    skipped: 'Run skipped',
    error: 'The run could not be started.',
    disabled: 'Enable the job before running it.',
  },

  deleteDialog: {
    title: 'Delete job',
    description: 'This permanently deletes “{name}” and its run history. This cannot be undone.',
    confirm: 'Delete job',
    cancel: 'Cancel',
    error: 'The job could not be deleted.',
  },

  builder: {
    createTitle: 'New job',
    editTitle: 'Edit job',
    createSubtitle:
      'Write the prompt this job sends, choose what it produces, and set when it runs. The preview shows exactly what the agent receives.',
    editSubtitle:
      'Adjust the prompt, the output or the schedule. The preview shows exactly what the agent receives.',

    detailsSection: 'Details',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Weekly OIB fire-safety scan',
    nameRequired: 'A name is required.',
    nameTooLong: 'The name is too long (max 200 characters).',

    promptSection: 'Prompt',
    promptLabel: 'What this job asks',
    promptPlaceholder:
      'Check the current project documents for open fire-safety points and list every deviation with its OIB clause.',
    promptHint:
      'This is what fires. Write it exactly as you would type it into a new chat — the run starts with no other context.',
    promptRequired: 'A prompt is required.',
    promptTooLong: 'The prompt is too long (max 8000 characters).',

    outputSection: 'Output',
    outputLabel: 'What a run produces',
    outputHint: 'This also decides which skills the job can attach.',
    output: {
      chatLabel: 'Chat',
      chatHint: 'a chat you can open and continue',
      deepResearchLabel: 'Deep research',
      deepResearchHint: 'a report',
    },

    skillSection: 'Skill',
    skillLabel: 'Attached skill',
    skillOptional: 'Optional',
    skillHint:
      'A skill is added on top of the prompt, exactly as typing “/name” before the message would. Most jobs need none.',
    skillNone: 'No skill',
    skillNoneHint: 'The prompt runs on its own.',
    skillPlaceholder: 'No skill',
    skillsLoading: 'Loading skills…',
    skillsError: 'The skills could not be loaded — the job can still be saved without one.',
    skillsEmpty: 'No skill can run with this output kind.',
    // Shown inline when switching the output kind drops the attached skill.
    skillDetached: '“{name}” cannot run as {output}, so it was detached.',

    sourcesSection: 'Data sources',
    knowledgeAlways: 'Project documents & OIB knowledge base — always included in every run',
    additionalSourcesLabel: 'Additional sources',
    sourcesHint:
      'Add sources beyond the knowledge base. Leave all unchecked to allow every available additional source.',
    sourcesAll: 'All available sources',
    sourcesLoading: 'Loading sources…',
    sourcesError: 'Sources could not be loaded — the job will use all available sources.',

    scheduleSection: 'Schedule',
    enableScheduleLabel: 'Run on a schedule',
    enableScheduleHint: 'When off, the job only runs when you press “Run now”.',
    presetLabel: 'Frequency',
    cronLabel: 'Cron expression',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Five fields: minute hour day-of-month month day-of-week.',
    cronInvalid: 'Enter a valid 5-field cron expression.',
    timezoneLabel: 'Timezone',

    enabledLabel: 'Enabled',
    enabledHint: 'A disabled job never fires on schedule and cannot be run manually.',

    save: 'Save job',
    saving: 'Saving…',
    cancel: 'Cancel',
    createSuccess: 'Job created.',
    updateSuccess: 'Job saved.',
    saveError: 'The job could not be saved.',

    preview: {
      title: 'What the agent receives',
      subtitle:
        'The exact text submitted when this job runs. The server builds this same prompt at fire time.',
      empty: 'Write a prompt to see what the agent receives.',
    },
  },

  history: {
    title: 'Run history',
    loading: 'Loading runs…',
    loadError: 'The run history could not be loaded.',
    empty: 'This job has not run yet.',
    viewReport: 'View report',
    viewProgress: 'View progress',
    viewThinking: 'View thinking',
    scheduler: 'Scheduler',
    trigger: {
      manual: 'Manual',
      schedule: 'Scheduled',
    },
    // How the submission went (job_runs.status).
    status: {
      submitted: 'Submitted',
      skipped: 'Skipped',
      error: 'Error',
    },
    // How the run itself is going, read from the backend job store.
    jobStatus: {
      submitted: 'Queued',
      pending: 'Queued',
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
  },
}
