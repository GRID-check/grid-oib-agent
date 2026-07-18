/** Navigation shell: sidebar, topbar, user menu, and the History page. */
export const nav = {
  projectNavigation: 'Project navigation',
  projectSections: 'Project sections',
  allProjects: 'Piloti — all projects',
  collapseSidebar: 'Collapse sidebar',
  expandSidebar: 'Expand sidebar',
  openNavigation: 'Open navigation',
  closeNavigation: 'Close navigation',
  sections: {
    chat: 'Ask Piloti',
    files: 'Files',
    knowledge: 'Knowledge',
    research: 'Research',
    workflows: 'Workflows',
    archiv: 'Archiv',
    history: 'History',
    settings: 'Settings',
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
    subtitle: 'Every conversation and deep-research run in this project.',
    conversationsHeading: 'Conversations',
    researchHeading: 'Deep research',
    searchPlaceholder: 'Search conversations…',
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
