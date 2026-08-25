/** Navigation shell: sidebar, topbar, user menu, and the History page. */
export const nav = {
  projectNavigation: 'Project navigation',
  projectSections: 'Project sections',
  /** The same rail, in org scope — above any single project. */
  orgNavigation: 'Organization navigation',
  orgSections: 'Organization sections',
  /**
   * Fallback for the org rail's back control, used only when the tab has no
   * return trail to name the project the reader actually came from.
   */
  backToProjects: 'Back to projects',
  allProjects: 'Piloti — all projects',
  collapseSidebar: 'Collapse sidebar',
  expandSidebar: 'Expand sidebar',
  /**
   * The rail's outer edge, which is a resize handle and a tab stop — hence a
   * name of its own rather than the collapse control's: what it does is set the
   * width, and folding the rail is the far end of that same move.
   */
  resizeSidebar: 'Resize sidebar',
  /** Tooltip on that edge, in each of the two states it can be in. */
  resizeSidebarHint: 'Drag to resize, click to collapse',
  expandSidebarHint: 'Drag or click to expand the sidebar',
  openNavigation: 'Open navigation',
  closeNavigation: 'Close navigation',
  sections: {
    chat: 'Ask Piloti',
    files: 'Files',
    knowledge: 'Knowledge',
    research: 'Research',
    skills: 'Skills',
    jobs: 'Jobs',
    archiv: 'Archiv',
    history: 'History',
    settings: 'Settings',
    // The intake wizard, labelled "Setup" in the product (⌘K palette only).
    intake: 'Setup',
  },
  /** Org-scope group headings. Deliberately NOT shared with `sectionGroups`:
   * the same word must not head two different sets of destinations. */
  orgSectionGroups: {
    work: 'Organization-wide',
    account: 'Administration',
  },
  scope: {
    /** Stated inside the org region, so the scope survives grayscale. */
    orgEyebrow: 'Organization-wide — not this project',
  },
  sectionGroups: {
    work: 'Work',
    automate: 'Automate',
    org: 'Organization',
    /** Org-scope rail: the organization, platform and account destinations. */
    account: 'Administration',
  },
  /**
   * The back control on pages outside the project shell (`BackLink`): `{label}`
   * is the name of the location the reader actually came from, resolved from the
   * tab's return trail.
   */
  backTo: 'Back to {label}',
  /**
   * Names for return destinations that have no nav entry of their own to borrow
   * a label from. Sections that DO (chat, files, …) are named by
   * `nav.sections.*`, so the back control and the rail can never disagree.
   */
  returnTargets: {
    project: 'the project',
    members: 'the project team',
    model: 'the model',
    organization: 'the organization',
    platform: 'the platform',
    profile: 'your profile',
  },
  /**
   * Browser-tab title fragments. `{label}` is the localized section name; the
   * project name is user data and is never translated.
   */
  tabTitle: {
    intake: 'Setup',
    researchProgress: '{percent}% · {label} — Piloti',
    researchActive: '⏳ {label} — Piloti',
  },
  projectSwitcher: {
    select: 'Select project',
    switchCurrent: 'Switch project (current: {name})',
    switchHeading: 'Switch project',
    projectSettings: 'Settings for {name}',
    projects: 'Projects',
    allProjects: 'All projects',
    viewAllProjects: 'View all projects',
    newProject: 'New project',
  },
  orgTopbar: {
    organization: 'Organization',
  },
  userMenu: {
    label: 'User menu for {name}',
    defaultUser: 'Default User',
    authNotConfigured: 'Authentication not configured',
    profile: 'Profile',
    archiv: 'Archiv',
    organization: 'Organization',
    platform: 'Platform',
    settings: 'Settings',
  },
  /** The project History page: conversations + research runs (FB-10). */
  history: {
    conversationsHeading: 'Conversations',
    researchHeading: 'Deep research',
    filterAll: 'All',
    filterAria: 'Filter history by type',
    typeConversation: 'Conversation',
    tagFilterLabel: 'Topics:',
    tagFilterAria: 'Filter conversations by topic',
    tagFilterClear: 'Clear',
    tags: {
      brandschutz: 'Fire safety',
      schallschutz: 'Sound insulation',
      barrierefreiheit: 'Accessibility',
      energie: 'Energy & thermal',
      statik: 'Structural',
      hygiene: 'Hygiene & environment',
      nutzungssicherheit: 'Safety in use',
      allgemein: 'General',
    },
    searchPlaceholder: 'Search history…',
    searchAria: 'Search conversations by title',
    untitledConversation: 'Untitled conversation',
    openConversation: 'Open conversation "{title}" in chat',
    emptyTitle: 'No conversations yet',
    emptyDescription: 'Ask Piloti a question in chat — every conversation shows up here.',
    emptyAction: 'Open chat',
    noMatchesTitle: 'No matching conversations',
    noMatchesDescription: 'Try a different search term.',
    errorTitle: 'Conversations could not be loaded',
    tryAgain: 'Try again',
  },
}
