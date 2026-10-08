/** projects namespace — populated during component i18n. */
export const projects = {
  list: {
    heading: 'Projects',
    description:
      'Every building project in one workspace — documents, members, and chat, grounded in the files, the office archive, and building law.',
    loading: 'Loading projects…',
    searchPlaceholder: 'Search projects…',
    searchAria: 'Search projects by name',
    resume: {
      // Shown when the rail is filled by the viewer's own activity…
      heading: 'Pick up where you left off',
      // …and when they have not worked in any project yet, so the rail is
      // filled by project recency instead. Never claim a "continue" that isn't.
      fallbackHeading: 'Your projects',
    },
    // "More", not "All": this list is everything minus the resume rail, and a
    // count that disagrees with the heading above it is worse than a plainer word.
    more: {
      heading: 'More projects',
    },
    results: {
      heading: 'Matches',
    },
    noMatch: {
      title: 'No matching projects',
      description: 'No project name matches your search.',
      clear: 'Clear search',
    },
    empty: {
      title: 'Start your first project',
      description:
        'Piloti is the workspace in which a planning office runs a building project. Create a project to bring its documents, members, and chat together — then ask Piloti about the work, grounded in the files, the office archive, and Austrian building law.',
      action: 'Create your first project',
    },
    filter: {
      label: 'Filter projects by status',
      active: 'Active',
      closed: 'Closed',
      all: 'All',
    },
    noneInFilter: {
      active: 'No active projects',
      closed: 'No closed projects',
      description: 'There are no projects in this view.',
      showAll: 'Show all projects',
    },
  },
  section: {
    loading: 'Loading…',
  },
  steckbrief: {
    heading: 'Project profile',
    description: 'The key facts that stay once the project is closed: where, when and with whom.',
    address: 'Address',
    addressMissing: 'No address yet. It is entered in the brief.',
    period: 'Period',
    startedOn: 'Start',
    endedOn: 'Completion',
    open: 'open',
    savePeriod: 'Save period',
    periodSaved: 'Period saved.',
    periodInvalid: 'The completion lies before the start.',
    people: 'People',
    peopleDescription:
      'Everyone who worked on the project, including former staff and external planners without a Piloti account. Only name, function, company and period; Piloti does not use these details in answers.',
    noPeople: 'Nobody entered yet.',
    name: 'Name',
    function: 'Function',
    company: 'Company',
    from: 'from',
    to: 'to',
    account: 'Piloti account',
    noAccount: 'No account',
    add: 'Add person',
    save: 'Save',
    cancel: 'Cancel',
    edit: 'Edit {name}',
    remove: 'Remove {name}',
    removeTitle: 'Remove this person?',
    removeDescription: '{name} and every detail about them will be deleted from the project profile for good.',
    removeConfirm: 'Remove for good',
    removed: 'Person removed.',
    saved: 'Saved.',
    error: 'That did not work. Please try again.',
  },
  cleanup: {
    title: 'Close project',
    intro:
      'Before closing, Piloti can clear out working copies, superseded versions, duplicates, temporary files and drafts that were never published. You decide about every item.',
    loading: 'Piloti is going through the files …',
    aiNotice:
      'AI proposal: made by Piloti from file names, folders, types and the existing summaries, without reading the files again. Check every item.',
    aiUnavailable:
      'The AI check was not available just now. The proposals come from fixed rules only, such as lock files, "Copy of …" or older version numbers.',
    considered: '{count} files checked that you may edit.',
    none: 'Piloti proposes nothing to remove.',
    unavailable: 'The proposals could not be loaded. You can still close the project.',
    binNote: 'What you select goes to the bin for 14 days and can be restored from there.',
    aiChip: 'AI proposal',
    selectAll: 'Select all',
    confirm: 'Move {count} to the bin and close',
    closeOnly: 'Close without removing anything',
    cancel: 'Cancel',
    removed: '{count} files moved to the bin.',
    error: 'Clearing out did not work; the project is still open.',
    /** The clean-out failed and could not be fully undone (ADR-0090): where to look. */
    partial:
      'Clearing out did not work and could not be fully undone. Some files may still be in a folder „{folders}“ inside their folder, or in the Papierkorb. The project is still open.',
    rules: {
      'lock-file': 'Lock file of an Office program',
      'temp-file': 'Temporary file',
      'system-file': 'System file',
      'copy-name': 'Working copy (name)',
      'old-name': 'Marked as old (name)',
      'same-content': 'Same content as an older file',
      'older-version': 'Older version; a newer one is in the same folder',
      'unpublished-draft': 'Draft by Piloti, never published',
    },
  },
  lifecycle: {
    fileChip: '{name} · closed',
    fileChipNoName: 'Closed project',
    banner: {
      title: 'Closed project · read-only',
      closedOn: 'Closed on {date}.',
      body: 'Files, folders, the brief and project memory can no longer be changed. You can still ask about it in chat.',
      outsider:
        'You can see this project because closed projects are readable by the whole office. Folders with their own access list stay hidden from you.',
    },
    card: {
      heading: 'Project status',
      activeDescription:
        'Close the project when the work is done. It stays complete and searchable, becomes read-only and can be read by everyone in the office. Folders with their own access list stay restricted.',
      closedDescription:
        'The project is closed and read-only. Reopen it to change files, folders, the brief or project memory. Only its members will see it again.',
      closedOn: 'Closed on {date}',
      close: 'Close project',
      reopen: 'Reopen project',
    },
    closeDialog: {
      description:
        'Afterwards nobody can change its files, folders, brief or project memory, and deep research and tasks stop running. Everyone in the office can read it and ask about it. You can reopen it at any time. If the project profile has no completion yet, the current month is entered.',
    },
    reopenDialog: {
      title: 'Reopen this project?',
      description: 'The project becomes editable again, and only its members will see it.',
      confirm: 'Reopen',
    },
    toast: {
      closed: 'Project closed.',
      reopened: 'Project reopened.',
      error: 'The project status could not be changed.',
    },
  },
  card: {
    summaryFallback:
      'Planning-office workspace. Add documents and a brief so Piloti can work from this project.',
    status: {
      active: 'Active',
      closed: 'Closed',
    },
    lastActivity: 'Last activity',
    /** The viewer's OWN last message in the project — not the project's. */
    yourActivity: 'You were last here',
    document: 'document',
    documents: 'documents',
    docLabel: '{count} {unit}',
    open: 'Open {name}',
    settingsAria: 'Open settings for {name}',
  },
  archivCard: {
    title: 'Archiv',
    subtitle:
      "Your office's organization-wide knowledge — shared documents and proven details, available in every project.",
    aria: 'Open the organization-wide Archiv',
  },
  dialog: {
    newProject: 'New project',
    title: 'Create a project',
    description:
      'A project is a focused workspace for one building — its documents, members, research, and chat context stay together.',
  },
  form: {
    nameRequired: 'Project name is required.',
    nameTooLong: 'Project name must be at most 255 characters.',
    createError: "We couldn't create this project just now. Please try again in a moment.",
    nameLabel: 'Project name',
    namePlaceholder: 'OIB fire safety review',
    templateLabel: 'Start from a template',
    templates: {
      neubauWohnbau: { label: 'New residential build', name: 'New residential build' },
      betriebsbauBrandschutz: {
        label: 'Commercial build — fire safety',
        name: 'Commercial build — fire safety',
      },
      sanierungBestand: {
        label: 'Existing-building renovation',
        name: 'Existing-building renovation',
      },
      oibBrandschutzAudit: { label: 'OIB fire-safety audit', name: 'OIB fire-safety audit' },
    },
    footnote:
      'Create a workspace for documents, members, and chat, grounded in the project files, the office archive, and building law.',
    submit: 'Create project',
  },
  applicableStandards: {
    heading: 'Applicable standards',
    description: 'OIB-Richtlinien relevant to this project, based on the brief.',
    briefIncomplete: 'Complete the project brief for applicability tailored to this building.',
    status: {
      required: 'Required',
      check: 'Check',
      likely: 'Likely',
    },
    askQuestion: 'Which requirements of {code} ({title}) apply to this project?',
    source: 'Source',
    sourceAria: 'Open the source for {code}',
    sourceTitle: 'Open the OIB source',
    askGrid: 'Ask Piloti',
    askGridAria: 'Ask Piloti about {code}',
    askGridTitle: 'Ask Piloti about this Richtlinie',
    emptyTitle: 'No applicable standards yet',
    emptyDescription:
      'Complete the project brief so Piloti can work out which OIB-Richtlinien apply to this building.',
    disclaimer:
      'Orientation only — not legal advice. Confirm applicability against the current Bauordnung and the authority having jurisdiction.',
  },
  dangerZone: {
    deleteSuccess: 'Project deleted. An organization admin can restore it until {date}.',
    deleteSuccessNoDate:
      'Project deleted. An organization admin can restore it during the grace period.',
    deleteError: 'Failed to delete project.',
    heading: 'Danger zone',
    description:
      'Deleting a project removes its documents, chats, research history, and knowledge base everywhere. Restorable for a limited grace period, then permanently purged.',
    deleteButton: 'Delete project',
    dialogTitle: 'Delete project',
    dialogDescriptionBefore: 'This deletes ',
    dialogDescriptionAfter:
      ' and all associated data across the entire app: files, chats, research runs, and its knowledge base.',
    confirmLabel: 'Delete project',
    typeToConfirm: 'Type {name} to confirm:',
  },
  recentlyDeleted: {
    restoreSuccess: 'Restored "{name}".',
    restoreError: 'Restore failed.',
    heading: 'Recently deleted',
    purgeFailed: 'Purge failed — contact support',
    purgeAfter: 'Permanently purged after {date}',
    restore: 'Restore',
    loadError: 'Could not load recently deleted projects.',
    retry: 'Retry',
  },
  researchRuns: {
    hint: {
      noReport: 'No report',
    },
    status: {
      running: 'Running',
      submitted: 'Submitted',
      pending: 'Pending',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    loadError: 'Failed to load research runs',
    errorTitle: "Couldn't load research runs",
    tryAgain: 'Try again',
    emptyTitle: 'No research runs yet',
    emptyDescription:
      'Deep research runs appear here once you ask Piloti an involved question in Chat — it works the OIB/RIS sources and returns a cited report you can revisit.',
    emptyAction: 'Start a run in Chat',
    viewReport: 'View report',
    viewProgress: 'View progress',
  },
  intake: {
    validation: {
      selectOption: 'Select an option to continue.',
      selectAtLeastOne: 'Select at least one option.',
      chooseYesNo: 'Choose Yes or No.',
      enterNumber: 'Enter a number.',
      required: 'This field is required.',
    },
    errors: {
      loadFailed: 'We could not load the project questions.',
      saveConflict: 'This brief was changed elsewhere. Please refresh and try again.',
      saveFailed: 'We could not save the project brief. Please try again.',
    },
    tryAgain: 'Try again',
    conflictReload: 'Refresh',
    draftSaved: 'Draft saved',
    salvage: {
      partial:
        'Parts of the existing project brief could not be loaded and will be replaced when you save.',
      full: 'The existing project brief could not be loaded. Anything you enter here will replace it when you save.',
    },
    eyebrowEdit: 'Edit project brief',
    eyebrowCreate: 'Project setup',
    titleFallback: 'Tell Piloti about this project',
    subtitle:
      'About 2 minutes. Piloti uses this brief to ground every answer — and to show which OIB Richtlinien apply to this building.',
    moduleNav: 'Modules',
    moduleNavAria: 'Wizard modules',
    schnellstart: 'Quick start',
    schnellstartOn:
      'Core questions only. Everything else is recorded as “open” and listed in the summary as an open point.',
    schnellstartOff: 'Every question in this module.',
    skipRest: 'Skip the rest',
    skipRestDone: 'Recorded as open',
    moduleProgress: '{answered} of {total}',
    moduleDone: 'complete',
    coreBadge: 'Core question',
    hiddenByQuickstart:
      '{count, plural, one {# more question} other {# more questions}} hidden in quick start',
    showAllHere: 'Show all here',
    progressAria: 'Progress',
    reviewTitle: 'Review & confirm',
    reviewStep: 'Review',
    reviewDescription: 'Confirm what Piloti understood about this project before saving.',
    back: 'Back',
    stepCounter: 'Step {current} of {total}',
    saving: 'Saving…',
    saveSuccess:
      'Project profile saved — {count, plural, one {# detail} other {# details}} captured',
    saveChanges: 'Save changes',
    saveAndSee: 'Save & see my standards',
    next: 'Next',
    unknownsTitle: "Piloti still won't know",
    unknownsHint:
      'You can save now and fill these in later — Piloti will flag them as open questions.',
    edit: 'Edit',
    optional: '(optional)',
    yes: 'Yes',
    no: 'No',
    open: 'still open',
    why: 'Why do we ask?',
    selectPlaceholder: 'Select…',
    mode: {
      aria: 'Answer mode',
      wert: 'Value',
      geschaetzt: 'Estimate',
      offen: 'still open',
    },
    bauwerk: {
      nameAria: 'Name of the building',
      remove: 'remove',
      add: 'Add building',
    },
    upload: {
      hint: 'Store the document in the Files tab',
    },
    derived: {
      badge: 'from the brief',
    },
    classification: {
      title: 'What this brief is for',
      description:
        'The building class is confirmed here when you know it. If it is still open, Piloti asks in chat before an answer that hangs on it. The brief is the working basis for which rules apply and which points are still open.',
    },
    consistency: {
      checking: 'Checking your answers…',
      title: 'A couple of things to check',
      subtitle: 'Some answers look like they might not fit together. Review them, or save anyway.',
      severity: {
        warning: 'Worth a look',
        inconsistency: 'Likely conflict',
      },
      revise: 'Revise',
      proceed: 'Save anyway',
      rules: {
        fossilNeubauConflict:
          'A gas heat supply for {bauwerk} conflicts with a new build — the Erneuerbare-Wärme-Gesetz prohibits fossil systems in new buildings.',
      },
    },
  },
  memory: {
    kinds: {
      decision: 'Decisions',
      constraint: 'Constraints',
      open_question: 'Open questions',
      derived_fact: 'Derived facts',
      preference: 'Preferences',
    },
    kindSingular: {
      decision: 'Decision',
      constraint: 'Constraint',
      open_question: 'Open question',
      derived_fact: 'Derived fact',
      preference: 'Preference',
    },
    verification: {
      unverified: 'unverified',
      source_grounded: 'source-grounded',
      user_confirmed: 'confirmed by you',
    },
    provenance: {
      user: 'added by you',
      grid: 'noted by Piloti',
    },
    conflict: {
      badge: 'Conflicts with a confirmed note',
      title:
        'Conflicts with “{note}” — Piloti was not allowed to replace that note. Confirm or remove one of the two.',
      titleUnknown: 'Conflicts with a confirmed note that is no longer in this list.',
    },
    restricted: {
      badge: 'Restricted',
      title:
        'Drawn from restricted folders ({folders}). Only people cleared for all of them see this note, and only their chats are given it.',
      titleUnknown: 'Drawn from restricted folders. Only people cleared for all of them see this note.',
    },
    time: {
      justNow: 'just now',
      minutesAgo: '{count}m ago',
      hoursAgo: '{count}h ago',
      daysAgo: '{count}d ago',
    },
    errors: {
      requestFailed: 'Request failed ({status})',
      loadFailed: 'Failed to load project memory',
      updateFailed: 'Update failed',
      deleteFailed: 'Delete failed',
      addFailed: 'Could not add memory',
      title: 'Something went wrong with project memory',
    },
    added: 'Memory added.',
    updated: 'Memory updated.',
    deleted: 'Memory removed.',
    heading: 'Project memory',
    description: 'What Piloti has learned about this project — editable.',
    addMemory: 'Add memory',
    kindAria: 'Memory kind',
    scopeAria: 'Memory scope',
    scopeProject: 'This project',
    scopeOrganization: 'All my projects',
    addPlaceholder: 'One concise, self-contained finding about this project…',
    cancel: 'Cancel',
    add: 'Add',
    tryAgain: 'Try again',
    emptyTitle: 'Nothing recorded yet',
    emptyDescription:
      "Piloti hasn't recorded anything about this project yet. It will as you chat — or add something yourself.",
    orgWide: 'org-wide',
    confidence: '{confidence} confidence',
    save: 'Save',
    pinned: 'Pinned',
    remove: 'Remove',
    removeConfirm: 'Remove?',
    cancelRemovalAria: 'Cancel removal',
    cancelTitle: 'Cancel',
    unpin: 'Unpin',
    pin: 'Pin',
    unpinTitle: 'Unpin — stop always including this',
    pinTitle: 'Pin — always include this in context',
    confirm: 'Confirm',
    confirmTitle: 'Confirm — mark this as correct',
    edit: 'Edit',
    editTitle: 'Edit',
    removeAria: 'Remove',
    removeTitle: 'Remove from memory',
  },
  overview: {
    workspaceCreated: 'Project workspace · created {date}',
    workspace: 'Project workspace',
    askGrid: 'Ask Piloti',
    uploadFiles: 'Upload files',
    rename: {
      action: 'Rename project',
      dialogTitle: 'Rename project',
      dialogDescription:
        'Give this project a clear name. It is also the phrase required to confirm deletion.',
      nameLabel: 'Project name',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      success: 'Project renamed.',
      error: 'Could not rename the project. Please try again.',
      forbidden: "You don't have permission to rename this project.",
    },
    brief: {
      heading: 'Project Brief',
      edit: 'Edit brief',
      summaryGenerate: 'Generate summary',
      summaryRegenerate: 'Regenerate',
      summaryGenerating: 'Generating…',
      summaryWriting: 'Piloti is writing the project summary…',
      summarySuccess: 'Summary updated.',
      summaryError: 'Could not generate a summary. Please try again.',
      summaryLlmNotConfigured:
        'Summary generation is unavailable — no language model is configured. Ask an administrator to set one up.',
      summaryForbidden: "You don't have permission to generate the summary.",
      summaryUnavailable: 'The summary is currently unavailable.',
      summaryUnavailableLlm: 'No AI service is configured — please contact an administrator.',
      captured: '{answered} of {total} captured',
      focus: 'Focus',
      startedNoDetailsBefore: 'The brief has been started but no details are captured yet. ',
      completeBrief: 'Complete the brief',
      startedNoDetailsAfter: ' so Piloti can ground its answers.',
      missingHeading: "Piloti still doesn't know",
      assumptionsHeading: 'Suggested by Piloti — confirm to make it a project fact',
      assumptionConfirm: 'Confirm',
      assumptionDismiss: 'Dismiss',
      assumptionError: 'Could not update the brief. Please try again.',
      assumptionForbidden: "You don't have permission to update the brief.",
      assumptionConflict: 'This brief was changed elsewhere. Please refresh and try again.',
      provenance: {
        onboarding: 'Captured in the intake wizard',
        user_confirmed: 'Confirmed by you',
        admin_edit: 'Edited by an admin',
      },
      emptyTitle: 'Set up the project brief',
      emptyDescription:
        "Tell Piloti about this building — use, class, storeys and goals. A complete brief lets Piloti ground every answer in your project's real context.",
      emptyAction: 'Set up project context',
    },
    stats: {
      files: 'Files',
      totalSize: 'Total size',
      knowledgeBase: 'Knowledge base',
    },
    recentFiles: {
      heading: 'Recent Files',
      viewAll: 'View all',
      emptyTitle: 'No files yet',
      emptyDescription:
        'Upload building documents — plans, reports, the Bauordnung excerpts — so Piloti can cite your project when it answers.',
      emptyAction: 'Upload files',
    },
  },
}
