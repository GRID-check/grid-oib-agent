/**
 * Tasks with timing — a request, optionally on a timer, and the week it makes.
 *
 * A task fires its prompt into a fresh run the way a person opening a new
 * chat and typing would — once, or on the rhythm from step 3. A skill MAY be
 * attached on top, exactly as typing `/name` before the message would attach
 * it — the empty state (no skill) is the common case, and the copy below says
 * so. The skill toolbox itself lives in the `skills` namespace; nothing here
 * is about authoring skills.
 *
 * Two things this namespace now owns that it did not: the TIMETABLE's copy,
 * and a four-step WIZARD's. Both exist because a rhythm is the one thing in
 * the product a person cannot check by looking at it — so the surface spends
 * its words on making the commitment legible ("Every Monday at 06:00", the next
 * three real dates) rather than on naming cron fields.
 */
export const jobs = {
  title: 'Tasks',
  backToList: 'Back to list',
  loadError: 'The tasks could not be loaded.',
  tryAgain: 'Try again',

  list: {
    heading: 'Tasks',
    empty: {
      title: 'No tasks yet',
      description:
        'A task is a request with or without a rhythm. Write it once, choose whether it produces a chat or a report, and let Piloti work while you are somewhere else.',
      action: 'New task',
    },
    manualOnly: 'Manual only',
    onceOn: 'Once on {time}',
    onceDone: 'Done',
    // Terse on purpose: both sit on ONE footer line of a card, and the German
    // equivalents overflow it at grid width.
    nextRun: 'Next {time}',
    lastRun: 'Last {time}',
    neverRun: 'Never run',
    disabled: 'Paused',
    enableAria: 'Resume task “{name}”',
    disableAria: 'Pause task “{name}”',
    toggleError: 'The task could not be updated.',
    withSkill: 'Skill: {name}',
    noSkill: 'No skill',
    output: {
      chat: 'Chat',
      'deep-research': 'Report',
    },
  },

  card: {
    openAria: 'Open task “{name}”',
  },

  actions: {
    edit: 'Edit',
    runNow: 'Run now',
    delete: 'Delete',
  },

  /** The week grid. See `schedule-timetable.tsx` for why it exists at all. */
  timetable: {
    title: 'The week',
    legend: 'Tasks on this grid',
    thisWeek: 'This week',
    today: 'Today',
    previousWeek: 'Previous week',
    nextWeek: 'Next week',
    /** The band is cropped to the hours that carry something. */
    showFullDay: 'Show all 24 hours',
    showActiveHours: 'Show active hours only',
    nothing: 'Nothing',
    /** The marked break standing in for a long empty stretch of the day. */
    gap: '{hours} h',
    /** A cron the parser could not read — named, never silently left off. */
    unplaceable: 'Not shown on the grid: {names}',
    emptyNoSchedules: 'Nothing scheduled yet',
    emptyNoSchedulesHint: 'Create a task with a rhythm and this week fills in.',
    emptyThisWeek: 'Nothing fires this week',
  },

  schedule: {
    /** How often — the four answers the wizard offers. */
    frequency: {
      hourly: 'Hourly',
      daily: 'Daily',
      weekly: 'Weekly',
      monthly: 'Monthly',
    },
    // The humanized sentence on a card and in the drawer, built from the cron.
    summaryHourly: 'Hourly at :{minute}',
    summaryDaily: 'Daily at {time}',
    summaryWeekly: 'Every {weekday} at {time}',
    /** Monday–Friday is a phrase people use; five names in a row is not. */
    summaryWeekdays: 'Weekdays at {time}',
    summaryMonthly: 'Monthly on the {day}. at {time}',
    /** A cron the composer cannot express, shown verbatim rather than guessed at. */
    summaryCustom: 'Custom ({cron})',
    inTimezone: '{summary} · {timezone}',
  },

  run: {
    submitted: 'Started.',
    submittedDetail: 'It is running now — follow it under Tasks.',
    skipped: 'Skipped',
    error: 'That could not be started.',
    disabled: 'Resume the task before running it.',
  },

  deleteDialog: {
    title: 'Delete task',
    description: 'This permanently deletes “{name}” and its history. This cannot be undone.',
    confirm: 'Delete task',
    cancel: 'Cancel',
    error: 'The task could not be deleted.',
  },

  builder: {
    /** The rail. Four steps, one required decision each — see the wizard's docstring. */
    stepsLabel: 'Steps',
    stepProgress: 'Step {current} of {total}',
    steps: {
      task: 'Task',
      output: 'Result',
      schedule: 'When',
      review: 'Review',
      taskTitle: 'What should Piloti do?',
      taskHint:
        'Write it exactly as you would type it into a new chat. Piloti starts with no other context.',
      outputTitle: 'What should come out of it?',
      outputHint: 'This also decides which skills the task can use.',
      scheduleTitle: 'When should it run?',
      scheduleHint:
        'Once, recurring or on request — the next times are shown underneath, to check before you commit.',
      reviewTitle: 'Ready',
      reviewHint: 'This is what will happen. Nothing has been saved yet.',
    },
    next: 'Continue',
    back: 'Back',
    cancel: 'Cancel',
    create: 'Create task',
    save: 'Save task',
    saving: 'Saving…',

    nameLabel: 'Name',
    namePlaceholder: 'e.g. Weekly OIB fire-safety scan',
    nameHint: 'What this is called in the list. Left empty, the first line above is used.',
    nameRequired: 'A name is required.',
    nameTooLong: 'The name is too long (max 200 characters).',

    promptLabel: 'The request',
    promptPlaceholder:
      'Check the current project documents for open fire-safety points and list every deviation with its OIB clause.',
    promptHint: 'This is what fires, word for word, every time.',
    promptRequired: 'A request is required.',
    promptTooLong: 'The request is too long (max 8000 characters).',

    outputSection: 'Result',
    outputLabel: 'What comes out of it',
    output: {
      chatLabel: 'Chat',
      chatHint: 'A conversation you can open and keep going.',
      chatNoun: 'a chat',
      deepResearchLabel: 'Report',
      deepResearchHint: 'A researched document, filed in the project.',
      deepResearchNoun: 'a report',
    },

    /** Everything behind the one disclosure per step. */
    advancedOutput: 'Skill and data sources',
    advancedSchedule: 'Timezone and cron',

    skillSection: 'Skill',
    skillLabel: 'Attached skill',
    skillSummary: 'Skill: {name}',
    skillNone: 'No skill',
    skillNoneHint: 'The request runs on its own. Most tasks need no skill.',
    skillPlaceholder: 'No skill',
    skillsLoading: 'Loading skills…',
    skillsError: 'The skills could not be loaded — the task can still be saved without one.',
    skillsEmpty: 'No skill can run with this result kind.',
    // Shown inline when switching the result kind drops the attached skill.
    skillDetached: '“{name}” cannot run as {output}, so it was detached.',

    sourcesSection: 'Data sources',
    sourcesSummary: '{count} extra sources',
    knowledgeAlways: 'Project documents & OIB knowledge base — always included in every run',
    additionalSourcesLabel: 'Additional sources',
    sourcesHint:
      'Add sources beyond the knowledge base. Leave all unchecked to allow every available source.',
    sourcesAll: 'All available sources',
    sourcesLoading: 'Loading sources…',
    sourcesError: 'Sources could not be loaded — the task will use all available sources.',

    scheduleSection: 'When',
    cadence: {
      label: 'When should this task run',
      once: 'Once',
      onceHint: 'On a date you choose. After that it is done.',
      recurring: 'Recurring',
      recurringHint: 'On a rhythm, again and again.',
      manual: 'Manual only',
      manualHint: 'Runs only when you press “Run now”.',
    },
    dueAtLabel: 'Due date',
    dueAtHint: 'In your local time. The task runs exactly once.',
    presetLabel: 'How often',
    timeLabel: 'At',
    minuteLabel: 'At minute',
    minutePast: '{minute} past the hour',
    weekdayLabel: 'On',
    weekdayHint: 'Pick as many days as you need — Mon to Fri reads as “weekdays”.',
    monthDayLabel: 'On the',
    monthDayValue: '{day}.',
    /**
     * The next real fire times — the claim, made checkable.
     *
     * "Times", not "runs": a run that has not happened is not a run, and the
     * word for the ones that HAVE is Tasks. Future and past need different
     * nouns or the surface says the same word about two different things.
     */
    upcomingLabel: 'Next times',
    upcomingNone: 'This never fires — it only runs when started by hand.',

    customCronLabel: 'Write a cron expression',
    customCronHint: 'For rhythms the four options above cannot express.',
    cronLabel: 'Cron expression',
    cronPlaceholder: '0 6 * * 1',
    cronHint: 'Five fields: minute hour day-of-month month day-of-week.',
    cronInvalid: 'Enter a valid 5-field cron expression.',
    timezoneLabel: 'Timezone',
    timezoneHint: 'The task fires by the clock in this zone, daylight saving included.',

    enabledLabel: 'Active',
    enabledHint: 'A paused task never fires and cannot be run by hand.',

    /** The review step's one sentence. */
    reviewSentence: 'Piloti produces {output} {cadence}.',
    reviewSentenceOnce: 'Piloti produces {output} — once, on {dueAt}.',
    reviewSentenceManual: 'Piloti produces {output}, each time you start it by hand.',

    createAndRun: 'Create and run now',
    saveAndRun: 'Save and run now',
    runNowFailed: 'The task is saved; the first run could not be started.',

    createSuccess: 'Task created.',
    updateSuccess: 'Task saved.',
    saveError: 'The task could not be saved.',

    preview: {
      title: 'What the agent receives',
      subtitle:
        'The exact text submitted. The server builds this same prompt at fire time.',
    },
  },

  history: {
    title: 'Task history',
    loading: 'Loading tasks…',
    loadError: 'The history could not be loaded.',
    empty: 'This task has not run yet.',
    viewReport: 'View report',
    /** A `chat` run landed in a conversation — the run's output IS that chat. */
    openChat: 'Open chat',
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
