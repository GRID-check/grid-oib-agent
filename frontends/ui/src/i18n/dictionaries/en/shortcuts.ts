/** Keyboard shortcuts: command palette, cheatsheet, and the profile toggle. */
export const shortcuts = {
  palette: {
    title: 'Command palette',
    description: 'Search for a project or action and jump straight to it.',
    placeholder: 'Type a command or search…',
    empty: 'No results found.',
    groups: {
      projects: 'Projects',
      currentProject: 'Current project',
      general: 'General',
    },
    /** The intake wizard section (labelled "Setup" in the product). */
    intake: 'Setup',
    toggleTheme: 'Toggle theme',
    hints: {
      move: 'to move',
      open: 'to open',
      close: 'to close',
    },
  },
  cheatsheet: {
    title: 'Keyboard shortcuts',
    description: 'Navigate Piloti without leaving the keyboard.',
    thenSeparator: 'then',
    orSeparator: 'or',
    groups: {
      general: 'General',
      navigation: 'Jump to',
      chat: 'Chat',
    },
    /** Shown under the navigation group, which mixes scoped and global jumps. */
    projectScopeNote: 'Section jumps open that section of the project you are in.',
    items: {
      palette: 'Open the command palette',
      cheatsheet: 'Show this overview',
      dismiss: 'Close a dialog or menu',
      sendMessage: 'Send message',
      newLine: 'New line',
      mention: 'Mention a colleague',
      chooseOption: 'Pick a numbered option',
    },
    disableHint: 'You can turn shortcuts off in your profile settings.',
  },
  preference: {
    title: 'Keyboard shortcuts',
    description: 'Quick navigation with the command palette and shortcut keys.',
    label: 'Enable keyboard shortcuts',
    hint: 'Turns the command palette (Ctrl+K / ⌘K) and all shortcut keys on or off on this device.',
  },
}
