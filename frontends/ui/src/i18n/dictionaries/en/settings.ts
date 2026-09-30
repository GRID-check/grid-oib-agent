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
      inboundMail: 'Email inbox',
    },
    reindexDescription:
      'Rebuild the indexed content of every document in this project. Nothing you uploaded is deleted — only the derived chunks answers are grounded on. Use this after a change to how documents are indexed.',
    reindexAction: 'Re-index project',
    reindexBusy: 'Re-indexing…',
    reindexDone:
      '{count, plural, one {# document is} other {# documents are}} being re-indexed. The status updates as each one finishes.',
    reindexNothing: 'Nothing to re-index — no document in this project has stored content yet',
    reindexPartial:
      '{count, plural, one {# document} other {# documents}} could not be re-read. Their existing index is kept.',
    reindexFailed: 'Re-indexing could not be started',
    reindexTruncated:
      'Not every document was reached: one run covers the newest 10,000 documents, and the older ones keep their existing index.',
    membersDescriptionManage:
      'Assign project roles to organization members. Organization admins always have access.',
    membersDescriptionReadOnly:
      'Who has access to this project. Only project admins can change assignments.',
    knowledgeLink: 'Open knowledge base',
    /** The project's own mail address: attachments sent to it are filed into the project. */
    inboundMail: {
      description:
        'Send files as attachments to this address. They are filed in this project under E-Mail-Eingang.',
      addressLabel: 'Project email address',
      rulesLabel: 'What applies',
      rules: {
        members: 'Only project members who can edit documents can send to it.',
        verified:
          'The sender’s domain must be verifiable (DKIM or DMARC). Other mail is rejected.',
        size: 'At most 25 MB per email.',
        body: 'Piloti files the attachments only. The text of the email is not stored.',
      },
      helpLink: 'How it works, and why mail bounces',
      rotate: 'Generate new address',
      confirmTitle: 'Generate a new address?',
      confirmDescription:
        'The current address stops working immediately, and mail sent to it is rejected. Share the new address with everyone who sends files to this project.',
      confirmAction: 'Generate new address',
      rotated: 'New address generated',
      rotateFailed: 'The new address could not be generated. The current one still works.',
      loadFailedTitle: 'Address unavailable',
      loadFailed: 'The project’s email address could not be loaded.',
    },
    insights: {
      emptyTitle: 'No insights yet',
      emptyDescription:
        'Usage and source-mix insights for this project will appear here once evaluation is available.',
    },
  },
}
