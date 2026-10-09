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
      general: 'General',
      profile: 'Project profile',
      members: 'Members',
      memory: 'Memory',
      usage: 'Usage & budget',
      documents: 'Documents & index',
    },
    general: {
      identityTitle: 'Project',
      identityDescription: 'The name everyone in the organization sees for this project.',
      nameLabel: 'Project name',
      nameRequired: 'Enter a name.',
      save: 'Save',
      saved: 'Project renamed',
      saveError: 'Could not rename the project.',
      readOnlyHint: 'Only project admins can rename the project.',
      factsTitle: 'At a glance',
      created: 'Created',
      documents: 'Documents',
      storage: 'Storage',
      openFiles: 'Open files',
    },
    profile: {
      title: 'Project profile',
      description:
        'What Piloti assumes about this project in every answer: the facts from the briefing, the assumptions it still wants confirmed, and the standards those facts make relevant.',
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
