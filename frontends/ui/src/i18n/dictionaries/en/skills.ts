/**
 * Agent Skills (Phase A): the org skill toolbox plus project skill schedules.
 * Replaces the Workflows surface (ADR-0046): instead of editing a free-text
 * brief, a schedule pins ONE skill from the merged toolbox (builtin platform
 * skills + org-authored/cloned rows) and fires it manually or on a cron.
 */
export const skills = {
  title: 'Skills',
  subtitle:
    'Saved skills and schedules for this project. A schedule pins one skill from the toolbox and runs it on demand or on a recurring schedule — through the same pipeline as a chat request.',
  backToList: 'Back to skill schedules',
  loadError: 'The skills could not be loaded.',
  tryAgain: 'Try again',

  toolbox: {
    heading: 'Skill toolbox',
    hint: 'Built-in skills from Piloti plus skills your organization authored or cloned. Schedules pin one of these skills — editing a skill never changes an existing schedule (its snapshot is preserved).',
    newSkill: 'New skill',
    loadError: 'The skill toolbox could not be loaded.',
    empty: {
      title: 'No skills yet',
      description:
        'Author a skill for your organization, or clone a built-in one to adapt it. A skill is a reusable instruction (agentskills.io format) that schedules and chats can invoke.',
      action: 'New skill',
    },
    origin: {
      platform: 'Built-in',
      org: 'In this organization',
      cloned: 'Cloned',
    },
    execution: {
      chat: 'Chat mode',
      deepResearch: 'Deep research',
    },
    schedulable: 'Schedulable',
    notSchedulable: 'Not schedulable',
    actions: {
      clone: 'Clone',
      cloneAria: 'Clone skill “{name}” into this organization',
      edit: 'Edit',
      delete: 'Delete',
      viewBody: 'View instruction',
    },
  },

  list: {
    heading: 'Schedules',
    empty: {
      title: 'No schedules yet',
      description:
        'Create a schedule to run one skill from the toolbox — manually or on a recurring schedule.',
      action: 'New schedule',
    },
    manualOnly: 'Manual only',
    nextRun: 'Next run {time}',
    lastRun: 'Last run {time}',
    neverRun: 'Never run',
    disabled: 'Disabled',
    enableAria: 'Enable schedule “{name}”',
    disableAria: 'Disable schedule “{name}”',
    toggleError: 'The schedule could not be updated.',
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
    disabled: 'Enable the schedule before running it.',
  },

  deleteDialog: {
    title: 'Delete schedule',
    description: 'This permanently deletes “{name}” and its run history. This cannot be undone.',
    confirm: 'Delete schedule',
    cancel: 'Cancel',
    error: 'The schedule could not be deleted.',
  },

  builder: {
    createTitle: 'New schedule',
    editTitle: 'Edit schedule',
    createSubtitle:
      'Pick a skill from the toolbox and set when it runs. The preview shows exactly what the agent receives.',
    editSubtitle:
      'Adjust the skill or schedule. The preview shows exactly what the agent receives.',

    detailsSection: 'Details',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Weekly OIB fire-safety scan',
    nameRequired: 'A name is required.',
    nameTooLong: 'The name is too long (max 200 characters).',

    skillSection: 'Skill',
    skillLabel: 'Skill to run',
    skillPlaceholder: 'Select a skill…',
    skillRequired: 'Select a skill.',
    skillsLoading: 'Loading skills…',
    skillsError: 'The skills could not be loaded — save is disabled.',
    skillNotSchedulable: '“{name}” is marked as not schedulable and cannot run on a schedule.',

    sourcesSection: 'Data sources',
    knowledgeAlways: 'Project documents & OIB knowledge base — always included in every run',
    additionalSourcesLabel: 'Additional sources',
    sourcesHint:
      'Add sources beyond the knowledge base. Leave all unchecked to allow every available additional source.',
    sourcesAll: 'All available sources',
    sourcesLoading: 'Loading sources…',
    sourcesError: 'Sources could not be loaded — the schedule will use all available sources.',

    scheduleSection: 'Schedule',
    enableScheduleLabel: 'Run on a schedule',
    enableScheduleHint: 'When off, the schedule only runs when you press “Run now”.',
    presetLabel: 'Frequency',
    cronLabel: 'Cron expression',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Five fields: minute hour day-of-month month day-of-week.',
    cronInvalid: 'Enter a valid 5-field cron expression.',
    timezoneLabel: 'Timezone',

    enabledLabel: 'Enabled',
    enabledHint: 'A disabled schedule never fires on schedule and cannot be run manually.',

    save: 'Save schedule',
    saving: 'Saving…',
    cancel: 'Cancel',
    createSuccess: 'Schedule created.',
    updateSuccess: 'Schedule saved.',
    saveError: 'The schedule could not be saved.',

    preview: {
      title: 'What the agent receives',
      subtitle:
        'The skill’s instruction as submitted at run time. The server builds this same prompt when the schedule fires.',
      empty: 'Select a skill to see the prompt.',
    },
  },

  editor: {
    preview: {
      heading: 'SKILL.md',
      subtitle: 'Exactly what gets stored, and exactly what an agent reads.',
      level1: 'Always loaded',
      level1Hint:
        'Every skill contributes this much to the agent’s context on every turn — which is why the description has to say when the skill applies.',
      level2: 'Loaded on activation',
      level2Hint:
        'These instructions reach the agent only if it decides to use this skill, so length costs nothing until then.',
      descriptionPlaceholder: 'What this skill does, and when to use it.',
      emptyBody: 'No instructions yet.',
    },
    createTitle: 'New skill',
    editTitle: 'Edit skill',
    createSubtitle:
      'Author a reusable skill in the agentskills.io format: a name, a description and the instruction body.',
    editSubtitle: 'Adjust the skill. Existing schedules keep their saved snapshot.',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. oib-fire-check',
    nameRequired: 'A name is required.',
    nameTooLong: 'Skill names are at most 64 characters.',
    nameInvalid:
      'Skill names must be lowercase a-z/0-9 separated by single hyphens (no leading, trailing or consecutive hyphens).',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'When should the agent use this skill?',
    descriptionRequired: 'A description is required.',
    descriptionTooLong: 'Descriptions are at most 1024 characters.',
    bodyLabel: 'Instruction',
    bodyPlaceholder: 'The full instruction the agent follows when this skill runs.',
    bodyRequired: 'The instruction body is required.',
    bodyTooLong: 'Instruction bodies are at most 32000 characters.',
    executionLabel: 'Execution mode',
    executionHint:
      'How a schedule fires this skill. Chat mode runs it as a chat request; deep research runs the async research pipeline and produces a report.',
    schedulableLabel: 'Schedulable',
    schedulableHint:
      'Off means schedules cannot run this skill on a cron (manual runs stay possible).',
    cloneFrom: 'Cloned from “{name}”',
    enabledLabel: 'Enabled',
    enabledHint: 'A disabled skill cannot be added to new schedules.',
    save: 'Save skill',
    saving: 'Saving…',
    cancel: 'Cancel',
    createSuccess: 'Skill created.',
    updateSuccess: 'Skill saved.',
    saveError: 'The skill could not be saved.',
    deleteTitle: 'Delete skill',
    deleteDescription:
      'This removes “{name}” from the toolbox. Existing schedules keep their saved snapshot, so they keep running unchanged.',
    deleteConfirm: 'Delete skill',
  },

  history: {
    title: 'Run history',
    loading: 'Loading runs…',
    loadError: 'The run history could not be loaded.',
    empty: 'This schedule has not run yet.',
    viewReport: 'View report',
    viewProgress: 'View progress',
    viewThinking: 'View thinking',
    scheduler: 'Scheduler',
    trigger: {
      manual: 'Manual',
      schedule: 'Scheduled',
    },
    // How the submission went (skill_runs.status).
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

  // The `/` invocation surface in the chat composer.
  composer: {
    picker: {
      resultsAria: 'Available skills',
      // The empty state is the one place we can teach what a skill IS, so it
      // says where they come from rather than just reporting a count of zero.
      empty: 'No skills available yet',
      emptyHint: 'Skills your organization adds appear here. Manage them under Skills.',
      noResults: 'No skill matches “{query}”',
      noResultsHint: 'Skills are matched on their name and on what they say they are for.',
      loading: 'Loading skills',
      builtin: 'Built-in',
      keyboardHint: '↑↓ to choose · ↵ to insert · esc to dismiss',
    },
    // The chip shown under the composer once a skill is invoked.
    invoked: {
      label: 'Skill: {name}',
      hint: 'Its instructions load at the start of this turn.',
      remove: 'Remove the {name} skill from this message',
    },
    // How an activated skill is reported on the answer.
    activated: {
      one: '1 skill used',
      other: '{count} skills used',
      title: 'Skills used for this answer',
      // States the mechanism plainly: the description is always in context, the
      // instructions were pulled in only because the skill was activated.
      explainer:
        'The assistant sees every skill’s name and description at the start of a turn, and loads the full instructions only for the ones it activates. These were activated.',
    },
  },
}
