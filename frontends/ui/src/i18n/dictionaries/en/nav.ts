/** Navigation shell: sidebar, topbar, user menu. */
export const nav = {
  projectNavigation: 'Project navigation',
  projectSections: 'Project sections',
  allProjects: 'Grid — all projects',
  collapseSidebar: 'Collapse sidebar',
  expandSidebar: 'Expand sidebar',
  openNavigation: 'Open navigation',
  closeNavigation: 'Close navigation',
  sections: {
    overview: 'Overview',
    chat: 'Chat',
    files: 'Files',
    knowledge: 'Knowledge',
    research: 'Research',
    workflows: 'Workflows',
    members: 'Members',
  },
  /**
   * Browser-tab title fragments. `{label}` is the localized section name; the
   * project name is user data and is never translated.
   */
  tabTitle: {
    intake: 'Setup',
    researchProgress: '{percent}% · {label} — Grid',
    researchActive: '⏳ {label} — Grid',
  },
  projectSwitcher: {
    select: 'Select project',
    switchCurrent: 'Switch project (current: {name})',
    projects: 'Projects',
    allProjects: 'All projects',
    newProject: 'New project',
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
}