import type { ComponentType } from 'react'
import {
  Archive,
  BookOpenCheck,
  Boxes,
  ClipboardList,
  Clock,
  Folder,
  Inbox,
  MessageSquare,
  Settings,
  Sparkles,
  Zap,
} from 'lucide-react'

/**
 * The single source of truth for the project-centric navigation IA
 * (click-dummy overhaul §5, FB-9/FB-10).
 *
 * Historically the desktop rail (`app-sidebar`) and the ⌘K command palette
 * (`command-palette`) each hand-maintained their own parallel list of
 * destinations. They drifted: the palette could not reach Workflows (a real
 * rail item), and the same destinations used different icons (Compass vs
 * MessageSquare, Clock vs History, Folder vs FolderOpen). This module makes the
 * key, segment, icon, label, and flag gating for every project section live in
 * ONE place, so the rail and the palette can never disagree again.
 *
 * One icon per destination. Rail order (top → bottom, Settings pinned
 * separately): Ask Piloti · Workflows* · Skills* · Files · History · Archiv* ·
 * Inbox*. The palette additionally surfaces the palette-only destinations
 * Knowledge* and Setup (intake). A `*` marks a flag-gated section.
 *
 * Skills supersedes Workflows (ADR-0045): the layouts pass the flags mutually
 * exclusive — `showWorkflows = workflowsEnabled && !skillsEnabled` — so a
 * deployment never sees both sections.
 */

export type ProjectSectionKey =
  | 'chat'
  | 'workflows'
  | 'skills'
  | 'files'
  | 'model'
  | 'knowledge'
  | 'history'
  | 'archiv'
  | 'inbox'
  | 'intake'
  | 'settings'

/** The feature flags that gate individual project sections. */
export interface ProjectSectionFlags {
  /** Workflows page — feature-flagged, default off. */
  showWorkflows?: boolean
  /** Agent Skills page — feature-flagged, default off (ADR-0045). */
  showSkills?: boolean
  /** Org-wide Archiv — `organization-archiv` flag (ADR-0024). */
  canAccessArchiv?: boolean
  /** Project knowledge page — feature-flagged, default off. */
  showKnowledge?: boolean
  /** Collaboration surfaces — `collaboration` flag / env opt-in (ADR-0032…0035). */
  canCollaborate?: boolean
  /**
   * Inbox page + rail entry. Deliberately separate from `canCollaborate` since
   * ADR-0042: the inbox also carries operational alerts, which must reach a
   * tenant that does not have collaboration. `getNavFlags().canAccessInbox`.
   */
  canAccessInbox?: boolean
  /** Whether the IFC/BIM model page is enabled (`ifc-models`, ADR-0045). */
  showModels?: boolean
}

export interface ProjectSection {
  /** Stable React key and `nav.sections` label key. */
  key: ProjectSectionKey
  /** Project path segment, or null when `href` carries an absolute target. */
  segment: string | null
  /** Absolute href for items outside the project subtree (the org Archiv). */
  href?: string
  /** The one icon for this destination (lucide-react). */
  icon: ComponentType<{ className?: string }>
  /** Key under `nav.sections` used for the visible label. */
  i18nKey: string
  /**
   * Overrides where the visible label comes from. Default is
   * `nav.sections.<i18nKey>`; a section whose copy belongs to its own feature —
   * the inbox lives in the `collaboration` dictionary (ADR-0035) — declares it
   * here instead of duplicating the string into the nav dictionary.
   */
  label?: { namespace: 'collaboration'; key: string }
  /** Which flag gates this section, if any. `undefined` = always visible. */
  gate?: keyof ProjectSectionFlags
  /** Appears in the desktop/mobile rail's scrollable section nav. */
  inRail: boolean
  /** Appears in the ⌘K palette's "current project" group. */
  inPalette: boolean
  /**
   * Second key of the `g …` leader sequence that jumps here (lowercase, one
   * character). Declared alongside the destination on purpose: the shortcut
   * registry (`shortcuts.ts`) derives both the binding and the cheatsheet row
   * from this field, so a section can never gain a rail entry and silently
   * keep an undocumented — or stale — hotkey. Omit for destinations that
   * deliberately have no jump (the intake wizard is reached from the project
   * shell, not from muscle memory).
   */
  shortcutKey?: string
}

// Ordered once; both surfaces derive their lists by filtering this array, so
// the shared order (and any future insertion) stays consistent everywhere.
const PROJECT_SECTIONS: readonly ProjectSection[] = [
  {
    key: 'chat',
    segment: 'chat',
    icon: MessageSquare,
    i18nKey: 'chat',
    inRail: true,
    inPalette: true,
    shortcutKey: 'c',
  },
  {
    key: 'workflows',
    segment: 'workflows',
    icon: Zap,
    i18nKey: 'workflows',
    gate: 'showWorkflows',
    inRail: true,
    inPalette: true,
    shortcutKey: 'w',
  },
  {
    // Skills (ADR-0045): the layouts keep `showWorkflows` and `showSkills`
    // mutually exclusive, so this is the workflows entry's successor — it
    // inherits the same slot and the same `w` muscle memory.
    key: 'skills',
    segment: 'skills',
    icon: Sparkles,
    i18nKey: 'skills',
    gate: 'showSkills',
    inRail: true,
    inPalette: true,
    shortcutKey: 'w',
  },
  {
    key: 'files',
    segment: 'files',
    icon: Folder,
    i18nKey: 'files',
    inRail: true,
    inPalette: true,
    shortcutKey: 'f',
  },
  {
    // The IFC/BIM model page (ADR-0045). Sits next to Files because that is
    // where the model was uploaded and how a user thinks of it: the same
    // material, seen as a building rather than as a list of documents.
    key: 'model',
    segment: 'model',
    icon: Boxes,
    i18nKey: 'model',
    gate: 'showModels',
    inRail: true,
    inPalette: true,
    shortcutKey: 'm',
  },
  {
    key: 'knowledge',
    segment: 'knowledge',
    icon: BookOpenCheck,
    i18nKey: 'knowledge',
    gate: 'showKnowledge',
    // Palette-only: the rail's project IA does not carry a Knowledge section.
    inRail: false,
    inPalette: true,
    shortcutKey: 'k',
  },
  {
    key: 'history',
    segment: 'history',
    icon: Clock,
    i18nKey: 'history',
    inRail: true,
    inPalette: true,
    shortcutKey: 'h',
  },
  {
    // The org-wide Archiv (ADR-0024) keeps its org-scoped route; the entry is a
    // cross-project doorway, not a project subpage. Kept last so it hugs the
    // bottom of the rail's section nav, just above the pinned Settings.
    key: 'archiv',
    segment: null,
    href: '/app/archiv',
    icon: Archive,
    i18nKey: 'archiv',
    gate: 'canAccessArchiv',
    inRail: true,
    inPalette: true,
    shortcutKey: 'a',
  },
  {
    // The inbox (ADR-0035): one per user per organization, so — like the Archiv —
    // it keeps an org-scoped route and reads as a cross-project doorway rather
    // than a project subpage. IB-18 wants it reachable from anywhere in the app,
    // which is what a standing rail entry (plus its badge) delivers.
    //
    // Rail-only for now: the ⌘K palette labels every command from
    // `nav.sections.*`, and the inbox's copy lives in the collaboration
    // dictionary — wiring the palette is a separate change to that surface.
    key: 'inbox',
    segment: null,
    href: '/app/inbox',
    icon: Inbox,
    i18nKey: 'inbox',
    label: { namespace: 'collaboration', key: 'inbox.navLabel' },
    gate: 'canAccessInbox',
    inRail: true,
    inPalette: false,
    shortcutKey: 'i',
  },
  {
    // The intake wizard ("Setup"). Palette-only — the rail reaches it via the
    // project shell rather than a standing section.
    key: 'intake',
    segment: 'intake',
    icon: ClipboardList,
    i18nKey: 'intake',
    inRail: false,
    inPalette: true,
  },
]

/**
 * The pinned Settings entry (spec §5). The rail renders it separately from the
 * scrollable section nav (docked above the user footer); the palette lists it
 * inline. Kept out of {@link PROJECT_SECTIONS} so `railSections` never emits it
 * into the scrollable group.
 */
export const PROJECT_SETTINGS_SECTION: ProjectSection = {
  key: 'settings',
  segment: 'settings',
  icon: Settings,
  i18nKey: 'settings',
  inRail: true,
  inPalette: true,
  shortcutKey: 's',
}

function isVisible(section: ProjectSection, flags: ProjectSectionFlags): boolean {
  return section.gate ? Boolean(flags[section.gate]) : true
}

/**
 * The rail's scrollable section nav, in order, with flag-gated sections
 * filtered out. Excludes the pinned {@link PROJECT_SETTINGS_SECTION}, which the
 * shell docks separately.
 */
export function railSections(flags: ProjectSectionFlags): ProjectSection[] {
  return PROJECT_SECTIONS.filter((section) => section.inRail && isVisible(section, flags))
}

/**
 * The ⌘K palette's "current project" commands, in order, with flag-gated
 * sections filtered out. Includes the Settings entry inline (last).
 */
export function paletteSections(flags: ProjectSectionFlags): ProjectSection[] {
  return [...PROJECT_SECTIONS, PROJECT_SETTINGS_SECTION].filter(
    (section) => section.inPalette && isVisible(section, flags),
  )
}

/**
 * The destinations reachable with a `g …` leader sequence, in rail order with
 * Settings last, flag-gated sections filtered out. Membership is decided by the
 * section declaring a {@link ProjectSection.shortcutKey} — so the hotkey and the
 * cheatsheet row are both consequences of the IA, not a parallel list.
 */
export function jumpSections(flags: ProjectSectionFlags): ProjectSection[] {
  return [...PROJECT_SECTIONS, PROJECT_SETTINGS_SECTION].filter(
    (section) => section.shortcutKey && isVisible(section, flags),
  )
}
