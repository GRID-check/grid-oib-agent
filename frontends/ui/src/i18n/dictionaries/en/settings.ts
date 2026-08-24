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
    reindexDone:
      '{count, plural, one {# document is} other {# documents are}} being re-indexed. The status updates as each one finishes.',
    reindexNothing: 'Nothing to re-index — no document in this project has stored content yet',
    reindexPartial:
      '{count, plural, one {# document was} other {# documents were}} left unchanged because the old index could not be cleared first',
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
