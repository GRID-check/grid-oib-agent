import type { ComponentType } from 'react'
import {
  Archive,
  BookOpenCheck,
  ClipboardList,
  Clock,
  Folder,
  MessageSquare,
  Settings,
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
 * separately): Ask Piloti · Workflows* · Files · History · Archiv*. The palette
 * additionally surfaces the palette-only destinations Knowledge* and Setup
 * (intake). A `*` marks a flag-gated section.
 */

export type ProjectSectionKey =
  | 'chat'
  | 'workflows'
  | 'files'
  | 'knowledge'
  | 'history'
  | 'archiv'
  | 'intake'
  | 'settings'

/** The feature flags that gate individual project sections. */
export interface ProjectSectionFlags {
  /** Workflows page — feature-flagged, default off. */
  showWorkflows?: boolean
  /** Org-wide Archiv — `organization-archiv` flag (ADR-0024). */
  canAccessArchiv?: boolean
  /** Project knowledge page — feature-flagged, default off. */
  showKnowledge?: boolean
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
  /** Which flag gates this section, if any. `undefined` = always visible. */
  gate?: keyof ProjectSectionFlags
  /** Appears in the desktop/mobile rail's scrollable section nav. */
  inRail: boolean
  /** Appears in the ⌘K palette's "current project" group. */
  inPalette: boolean
}

// Ordered once; both surfaces derive their lists by filtering this array, so
// the shared order (and any future insertion) stays consistent everywhere.
const PROJECT_SECTIONS: readonly ProjectSection[] = [
  { key: 'chat', segment: 'chat', icon: MessageSquare, i18nKey: 'chat', inRail: true, inPalette: true },
  {
    key: 'workflows',
    segment: 'workflows',
    icon: Zap,
    i18nKey: 'workflows',
    gate: 'showWorkflows',
    inRail: true,
    inPalette: true,
  },
  { key: 'files', segment: 'files', icon: Folder, i18nKey: 'files', inRail: true, inPalette: true },
  {
    key: 'knowledge',
    segment: 'knowledge',
    icon: BookOpenCheck,
    i18nKey: 'knowledge',
    gate: 'showKnowledge',
    // Palette-only: the rail's project IA does not carry a Knowledge section.
    inRail: false,
    inPalette: true,
  },
  { key: 'history', segment: 'history', icon: Clock, i18nKey: 'history', inRail: true, inPalette: true },
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
