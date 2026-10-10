/** The right-side settings panel + the project Settings page. */
export const settings = {
  title: 'Settings',
  loading: 'Loading settings …',
  ariaLabel: 'Settings',
  savedAutomatically: 'Settings are saved automatically.',
  appearance: {
    uiTheme: 'UI Theme Options',
    uiThemeAria: 'UI theme',
  },
  language: {
    heading: 'Language',
    ariaLabel: 'Interface language',
  },
  openProfile: 'Open full profile',
  /**
   * The project Settings tier: one route per section, moved between by a
   * section nav (the organization tier's pattern). Each section answers one
   * question about the project; the copy below is grouped the same way.
   */
  project: {
    nav: {
      label: 'Project settings',
      overview: 'Overview',
      members: 'Members',
      memory: 'Memory',
      usage: 'Usage & budget',
      documents: 'Documents & index',
      references: 'Similar projects',
    },
    foldersWithoutRole: {
      title: 'Folders without a valid role',
      description:
        'The access lists of these folders name only roles that no longer exist. Until a valid role is set there, only organization admins can read them.',
      open: 'Open folder “{name}”',
    },
    overview: {
      createdOn: 'Created {date}',
      documentsCount: '{count, plural, one {# document} other {# documents}}',
      summaryEmpty: 'No briefing yet. Set one up so Piloti knows what this project is before it answers.',
      setUpBrief: 'Set up briefing',
      editBrief: 'Edit briefing',
      askPiloti: 'Ask Piloti',
      openFiles: 'Open files',
      actions: 'Project actions',
      rename: 'Rename',
      delete: 'Delete project',
      activity: {
        label: 'Activity',
        thisMonth: 'This month',
        questionsWord: '{count, plural, one {question} other {questions}}',
        questions: '{count, plural, one {# question} other {# questions}}',
        peopleLabel: 'People asking',
        empty: 'No questions in the last 30 days. Ask Piloti something about this project to get it going.',
      },
      similar: {
        label: 'Similar projects',
        open: '{count, plural, one {Open the similar project} other {All # similar projects}}',
        openOthers: 'See the closed projects',
        openMore: 'See more similar projects',
        empty: 'No closed project in the office yet. One appears here once it is closed.',
      },
      usage: {
        label: 'Used this month',
        noLimit: 'No monthly limit',
        blocked: 'Limit reached, requests are blocked',
        open: 'Usage & budget',
      },
      documents: {
        label: 'Documents',
        storage: '{size} stored',
        empty: 'No documents yet. Drop files anywhere in the project to add them.',
        open: 'Documents & index',
      },
      memory: {
        label: 'Memory',
        notes: '{count, plural, one {note} other {notes}}',
        toReview: '{count, plural, one {# to review} other {# to review}}',
        allReviewed: 'All confirmed',
        empty: 'Piloti has not noted anything about this project yet.',
        error: 'Memory could not be loaded.',
        open: 'Memory',
      },
      members: {
        label: 'Members',
        count: '{count, plural, one {person} other {people}}',
        empty: 'Nobody is assigned to this project yet.',
        error: 'The roster could not be loaded.',
        open: 'Members',
      },
    },
    members: {
      title: 'Members',
      description:
        'Assign project roles to organization members. Organization admins always have access.',
    },
    memory: {
      readOnlyHint: 'You can read what Piloti remembers. Changing it needs write access to the project.',
    },
    usage: {
      title: 'Usage',
      description:
        'What Piloti has used in this project, against the limits that would stop it. Windows are UTC: today since midnight, this month since the 1st.',
      today: 'Today',
      thisMonth: 'This month',
      requests: '{count, plural, one {# request} other {# requests}}',
      byModelTitle: 'By model, this month',
      empty: 'No usage recorded in this project this month.',
      limitTitle: 'Project limit',
      limitDescription:
        'A limit here stops Piloti in this project only, before the organization’s limit is reached. It can never exceed the organization’s limit.',
      noProjectLimit: 'No project limit. Only the organization’s limit applies.',
      orgCeiling: 'Organization limit: {limits}',
      orgCeilingNone: 'The organization has no limit set.',
      setLimit: 'Set limit',
      editLimit: 'Change limit',
      blockedProject: 'This project’s limit is exhausted. New requests here are blocked.',
      blockedOrganization: 'The organization’s limit is exhausted. New requests are blocked everywhere.',
    },
    documents: {
      uploadsTitle: 'Upload history',
      indexTitle: 'Knowledge index',
      indexDescription:
        'Rebuild the indexed content of every document in this project. Nothing you uploaded is deleted, only the derived chunks answers are grounded on. Use this after a change to how documents are indexed.',
      reindexAction: 'Re-index project',
      reindexConfirmTitle: 'Re-index every document in this project?',
      reindexBusy: 'Re-indexing…',
      reindexStarted:
        'Re-indexing started. It runs in the background and carries on after a restart; the status of each document updates as it finishes.',
      reindexFailed: 'Re-indexing could not be started',
      knowledgeTitle: 'Knowledge base',
      knowledgeDescription: 'What the project’s knowledge base contains, chunk by chunk.',
      knowledgeLink: 'Open knowledge base',
    },
  },
}
