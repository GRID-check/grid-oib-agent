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
   * The project Settings page (spec §5, FB-9): project parameters + members +
   * memory + insights + danger zone, consolidated from the old Overview and
   * Members pages.
   */
  project: {
    eyebrow: 'Project settings',
    createdOn: 'Created {date}',
    status: {
      active: 'Active',
      completed: 'Completed',
    },
    parameters: {
      fields: {
        name: 'Project name',
        location: 'Location',
        buildingClass: 'Building class',
        constructionType: 'Construction type',
        use: 'Use',
        status: 'Status',
      },
      notProvided: 'Not provided',
      edit: 'Edit details',
    },
    foldersWithoutRole: {
      title: 'Folders without a valid role',
      description:
        'The access lists of these folders name only roles that no longer exist. Until a valid role is set there, only organization admins can read them.',
      open: 'Open folder “{name}”',
    },
    sections: {
      parameters: 'Project parameters',
      members: 'Members',
      memory: 'Project memory',
      insights: 'Insights',
      reindex: 'Knowledge index',
    },
    reindexDescription:
      'Rebuild the indexed content of every document in this project. Nothing you uploaded is deleted — only the derived chunks answers are grounded on. Use this after a change to how documents are indexed.',
    reindexAction: 'Re-index project',
    reindexBusy: 'Re-indexing…',
    reindexStarted:
      'Re-indexing started. It runs in the background and carries on after a restart; the status of each document updates as it finishes.',
    reindexFailed: 'Re-indexing could not be started',
    membersDescriptionManage:
      'Assign project roles to organization members. Organization admins always have access.',
    membersDescriptionReadOnly:
      'Who has access to this project. Only project admins can change assignments.',
    knowledgeLink: 'Open knowledge base',
    insights: {
      emptyTitle: 'No insights yet',
      emptyDescription:
        'Usage and source-mix insights for this project will appear here once evaluation is available.',
    },
  },
}
