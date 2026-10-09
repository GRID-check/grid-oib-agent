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
      inboundMail: 'Project email address',
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
    /** The project's own mail address: attachments sent to it are filed into the project. */
    inboundMail: {
      description:
        'Send files as attachments to this address. Piloti files them in this project under E-Mail-Eingang, each email in a folder of its own.',
      addressLabel: 'Project email address',
      rulesLabel: 'What applies',
      rules: {
        members:
          'Project members who can edit documents can send to it, once the feature is switched on for the organization.',
        verified:
          'The sender’s domain must sign its mail with DKIM. Other mail is rejected.',
        addressing: 'Put the address in To or Cc. Mail that has it only in Bcc is rejected.',
        size: 'Attachments up to about 18 MB in total, and at most 100 files per email.',
        attachmentsOnly:
          'Only attachments are filed: not images pasted into the text, not links to cloud files. The text of the email is not stored.',
      },
      helpLink: 'How it works, and why mail bounces',
      rotate: 'Generate new address',
      confirmTitle: 'Generate a new address?',
      confirmDescription:
        'The current address stops working immediately, and mail sent to it is rejected. Share the new address with everyone who sends files to this project.',
      confirmAction: 'Generate new address',
      rotated: 'New address generated',
      rotateFailed: 'The new address could not be generated. The current one still works.',
      loadFailed: 'The project’s email address could not be loaded.',
    },
    insights: {
      emptyTitle: 'No insights yet',
      emptyDescription:
        'Usage and source-mix insights for this project will appear here once evaluation is available.',
    },
  },
}
