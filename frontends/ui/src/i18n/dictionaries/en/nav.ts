/** Navigation shell: sidebar, org header, and the user menu. */
export const nav = {
  projectNavigation: 'Project navigation',
  projectSections: 'Project sections',
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
    /** The merged Skills + Jobs section; the two live on as tabs inside it. */
    automation: 'Automation',
    skills: 'Skills',
    jobs: 'Jobs',
    archiv: 'Archiv',
    settings: 'Settings',
    // The intake wizard, labelled "Setup" in the product (⌘K palette only).
    intake: 'Setup',
  },
  sectionGroups: {
    work: 'Work',
    automate: 'Automate',
    org: 'Organization',
  },
  sectionSubtitles: {
    files: 'Documents that ground Piloti’s answers in this project.',
    automation: 'Skills the organization reuses, and prompts this project runs on a timer.',
    knowledge: 'What the knowledge base currently contains.',
    settings: 'Project profile, members, memory, and danger zone.',
    intake: 'Guided briefing for this project.',
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
  userMenu: {
    label: 'User menu for {name}',
    defaultUser: 'Default User',
    authNotConfigured: 'Authentication not configured',
    profile: 'Profile',
    organization: 'Organization',
    platform: 'Platform',
    settings: 'Settings',
  },
}
