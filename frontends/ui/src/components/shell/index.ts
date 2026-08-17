export { AppSidebar, type AppSidebarProps } from './app-sidebar'
export { BackLink, type BackLinkProps } from './back-link'
export { NavigationTrail, NavigationTrailLabel } from './navigation-trail'
export { CommandPalette, type CommandPaletteProps } from './command-palette'
export { KeyboardShortcuts, type KeyboardShortcutsProps } from './keyboard-shortcuts'
export { ShortcutsCheatsheet, type ShortcutsCheatsheetProps } from './shortcuts-cheatsheet'
export {
  jumpTargets,
  resolveJump,
  shortcutSections,
  modifierLabel,
  LEADER_KEY,
  LEADER_TIMEOUT_MS,
  MOD,
  type JumpTarget,
  type KeySegment,
  type ShortcutFlags,
  type ShortcutRow,
  type ShortcutSection,
} from './shortcuts'
export { OrgTopbar, type OrgTopbarProps } from './org-topbar'
// ProjectSectionFrame is a client module; re-exporting it next to OrgTopbar
// (server-only, `@/i18n/server`) is fine for server layouts. Client pages
// must import ProjectSectionActions from `./project-section-frame` directly —
// a barrel import would pull OrgTopbar into the client graph and next build
// dies on `server-only`.
export { ProjectSectionFrame } from './project-section-frame'
export {
  ProjectSwitcher,
  type ProjectSwitcherProject,
  type ProjectSwitcherProps,
} from './project-switcher'
export { SidebarUserMenu, type SidebarUser, type SidebarUserMenuProps } from './sidebar-user-menu'
