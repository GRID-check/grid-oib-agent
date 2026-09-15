/**
 * Zeitplan — a prompt on a timer, and the week it makes.
 *
 * A schedule fires its prompt into a fresh run the way a person opening a new
 * chat and typing would. A skill MAY be attached on top, exactly as typing
 * `/name` before the message would attach it — the empty state (no skill) is
 * the common case, and the copy below says so. The skill toolbox itself lives
 * in the `skills` namespace; nothing here is about authoring skills.
 *
 * Two things this namespace now owns that it did not: the TIMETABLE's copy,
 * and a four-step WIZARD's. Both exist because a schedule is the one thing in
 * the product a person cannot check by looking at it — so the surface spends
 * its words on making the commitment legible ("Jeden Montag um 06:00", the next
 * three real dates) rather than on naming cron fields.
 */
export const jobs = {
  title: 'Schedule',
  backToList: 'Back to schedules',
  loadError: 'The schedules could not be loaded.',
  tryAgain: 'Try again',

  list: {
    heading: 'Schedules',
    empty: {
      title: 'No schedules yet',
      description:
        'A schedule is a prompt on a timer. Write it once, choose whether it produces a chat or a report, and let Piloti work while you are somewhere else.',
      action: 'New schedule',
    },
    manualOnly: 'Manual only',
    // Terse on purpose: both sit on ONE footer line of a card, and the German
    // equivalents overflow it at grid width.
    nextRun: 'Next {time}',
    lastRun: 'Last {time}',
    neverRun: 'Never run',
    disabled: 'Paused',
    enableAria: 'Resume schedule “{name}”',
    disableAria: 'Pause schedule “{name}”',
    toggleError: 'The schedule could not be updated.',
    withSkill: 'Skill: {name}',
    noSkill: 'No skill',
    output: {
      chat: 'Chat',
      'deep-research': 'Report',
    },
  },

  card: {
    openAria: 'Open schedule “{name}”',
  },

  actions: {
    edit: 'Edit',
    runNow: 'Run now',
    delete: 'Delete',
  },

  /** The week grid. See `schedule-timetable.tsx` for why it exists at all. */
  timetable: {
    title: 'The week',
    legend: 'Schedules on this grid',
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
    emptyNoSchedulesHint: 'Create a schedule and this week fills in.',
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
    submittedDetail: 'It is running now — follow it in the schedule’s task list.',
    skipped: 'Skipped',
    error: 'That could not be started.',
    disabled: 'Resume the schedule before running it.',
  },

  deleteDialog: {
    title: 'Delete schedule',
    description: 'This permanently deletes “{name}” and its history. This cannot be undone.',
    confirm: 'Delete schedule',
    cancel: 'Cancel',
    error: 'The schedule could not be deleted.',
  },

  builder: {
    /** The rail. Four steps, one required decision each — see the wizard's docstring. */
    stepsLabel: 'Steps',
    stepProgress: 'Step {current} of {total}',
    steps: {
      task: 'Task',
      output: 'Result',
      schedule: 'Timing',
      review: 'Review',
      taskTitle: 'What should Piloti do?',
      taskHint:
        'Write it exactly as you would type it into a new chat. Piloti starts with no other context.',
      outputTitle: 'What should come out of it?',
      outputHint: 'This also decides which skills the schedule can use.',
      scheduleTitle: 'When should it run?',
      scheduleHint:
        'Pick a rhythm — the next times are shown underneath, to check before you commit.',
      reviewTitle: 'Ready',
      reviewHint: 'This is what will happen. Nothing has been saved yet.',
    },
    next: 'Continue',
    back: 'Back',
    cancel: 'Cancel',
    create: 'Create schedule',
    save: 'Save schedule',
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
    skillNoneHint: 'The request runs on its own. Most schedules need no skill.',
    skillPlaceholder: 'No skill',
    skillsLoading: 'Loading skills…',
    skillsError: 'The skills could not be loaded — the schedule can still be saved without one.',
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
    sourcesError: 'Sources could not be loaded — the schedule will use all available sources.',

    scheduleSection: 'Timing',
    enableScheduleLabel: 'Run on a schedule',
    enableScheduleHint: 'When off, it only runs when you press “Run now”.',
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
    timezoneHint: 'The schedule fires by the clock in this zone, daylight saving included.',

    enabledLabel: 'Active',
    enabledHint: 'A paused schedule never fires and cannot be run by hand.',

    /** The review step's one sentence. */
    reviewSentence: 'Piloti produces {output} {cadence}.',
    reviewSentenceManual: 'Piloti produces {output}, each time you start it by hand.',

    createSuccess: 'Schedule created.',
    updateSuccess: 'Schedule saved.',
    saveError: 'The schedule could not be saved.',

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
    empty: 'This schedule has not run yet.',
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
