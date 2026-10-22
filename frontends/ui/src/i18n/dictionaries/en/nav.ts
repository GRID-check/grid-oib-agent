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
    /** Automation — Tasks and Skills as tabs inside one section. */
    automation: 'Automation',
    /** Similar closed projects, read for this one (ADR-0094). */
    referenzen: 'Similar projects',
    skills: 'Skills',
    jobs: 'Jobs',
    /** The tab that leads: work delegated to Piloti, one card per task (ADR-0051). */
    tasks: 'Tasks',
    officeShelf: 'Office filing',
    settings: 'Overview',
    // The intake wizard, labelled "Setup" in the product (⌘K palette only).
    intake: 'Setup',
    // Piloti reads the project's documents; the person reviews (ADR-0111).
    setup: 'Setup',
  },
  sectionGroups: {
    work: 'Work',
    org: 'Organization',
  },
  sectionSubtitles: {
    files: 'This project’s documents. Piloti reads them and cites from them.',
    automation:
      'What Piloti did while you were away, what it will do next, and the skills it does it with.',
    knowledge: 'What the knowledge base currently contains.',
    settings: 'Where this project stands, and how it is set up.',
    intake: 'Guided briefing for this project.',
    setup: 'Project, filing, reading, questions, profile: Piloti reads, you check and confirm.',
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
    setup: 'Setup',
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
  /** The phone's bottom tab bar (`components/shell/phone-tab-bar.tsx`). */
  /** The muted count on Files in the rail and the tab bar: mail waiting in the E-Mail-Eingang. */
  inboundMailWaiting: '{count, plural, one {# mail waiting to be filed} other {# mails waiting to be filed}}',
  tabBar: {
    label: 'Main navigation',
    /** Opens the sheet with the destinations the bar does not carry. */
    more: 'More',
    /** The sheet behind "More" (`components/shell/phone-more-sheet.tsx`). */
    moreSheet: {
      title: 'More',
      description: 'More areas and your account.',
      close: 'Close',
      places: 'Areas',
      account: 'Account',
    },
  },
  search: {
    /** The touch door into the command palette, in both headers. */
    open: 'Search and jump',
  },
  /** The project switcher as a bottom sheet on a phone. */
  projectSheet: {
    description: 'The projects you opened last come first, then every running project.',
    close: 'Close',
    searchLabel: 'Search projects',
    searchPlaceholder: 'Search projects',
    clearSearch: 'Clear search',
    recent: 'Recently opened',
    others: 'Other projects',
    matches: 'Matching projects',
    noMatch: 'No running project has that name.',
  },
  userMenu: {
    label: 'User menu for {name}',
    defaultUser: 'Default User',
    authNotConfigured: 'Authentication not configured',
    profile: 'Profile',
    organization: 'Organization',
    platform: 'Platform',
    settings: 'Settings',
    productTour: 'Product tour',
  },
}
