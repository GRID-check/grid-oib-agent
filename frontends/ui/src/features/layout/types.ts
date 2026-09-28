/**
 * Layout Feature Types
 *
 * Type definitions for the main app layout including sidebars and panels.
 */

import type { DataSourceFromAPI } from '@/adapters/api'


/** Theme mode options */
export type ThemeMode = 'light' | 'dark' | 'system'

/** Tabs within the DataSources panel */
export type DataSourcesPanelTab = 'connections' | 'files'

/**
 * Composer source-preset shortcuts (WS-3). Each preset maps onto a subset of
 * the REAL data sources returned by the backend registry — see
 * `lib/source-presets.ts`. `null` = no preset active (manual selection).
 */
export type SourcePresetId = 'law' | 'project' | 'office'

/** Layout state for managing panels */
export interface LayoutState {
  /** Whether the sessions panel is open (left side) */
  isSessionsPanelOpen: boolean
  /**
   * Whether the global navigation drawer (AppSidebar's mobile drawer) is open.
   * Lifted into the store so the chat's floating toolbar can open it on mobile —
   * where the chat route hides the standalone global top bar to reclaim space.
   */
  isMobileNavOpen: boolean
  /** Active tab in the data sources panel */
  dataSourcesPanelTab: DataSourcesPanelTab
  /** IDs of enabled data sources (array for zustand serialization) */
  enabledDataSourceIds: string[]
  /** Current theme mode */
  theme: ThemeMode
  /** Dynamic data sources from API (null = not loaded yet) */
  availableDataSources: DataSourceFromAPI[] | null
  /** Whether the knowledge layer (file upload) is available */
  knowledgeLayerAvailable: boolean
  /**
   * Whether a vision model (VLM) is configured on the backend. Derived
   * capability carried alongside knowledgeLayerAvailable; image upload is
   * offered only when the `image-upload` flag allows AND this is true. Defaults
   * to false until the capability fetch confirms it.
   */
  vlmAvailable: boolean
  /** Whether data sources are being fetched */
  dataSourcesLoading: boolean
  /** Error message if data sources fetch failed */
  dataSourcesError: string | null
  /**
   * Show the raw technical reasoning steps (which agent/tool ran) inside the
   * Herleitung. OFF by default — the default trace is the user-friendly node
   * chain; power users opt in via the settings toggle. Persisted like a profile
   * preference.
   */
  showTechnicalReasoning: boolean
  /**
   * Active composer source preset (shortcut chips), or null when the user
   * manually manages sources. Cleared by any manual source toggle.
   */
  activeSourcePreset: SourcePresetId | null
  /**
   * @deprecated Use dataSourcesPanelTab instead
   */
  dataSourcePanelTab: DataSourcesPanelTab
}

/** Layout actions for state management */
export interface LayoutActions {
  /** Toggle sessions panel open/closed */
  toggleSessionsPanel: () => void
  /** Set sessions panel state */
  setSessionsPanelOpen: (open: boolean) => void
  /** Open/close the global mobile navigation drawer */
  setMobileNavOpen: (open: boolean) => void
  /** Set the active data sources panel tab */
  setDataSourcesPanelTab: (tab: DataSourcesPanelTab) => void
  /** Toggle a data source enabled/disabled by ID */
  toggleDataSource: (id: string) => void
  /** Set all enabled data sources */
  setEnabledDataSources: (ids: string[]) => void
  /** Set the theme mode */
  setTheme: (theme: ThemeMode) => void
  /** Record the user's Deep-Research preference (intent hint, not a guarantee) */
  /** Toggle the raw technical reasoning steps in the Herleitung (default off) */
  setShowTechnicalReasoning: (on: boolean) => void
  /**
   * Apply a composer source preset: sets the preset AND its computed enabled
   * source ids in one action (so the manual-toggle preset-clearing in
   * toggleDataSource/setEnabledDataSources doesn't fight it). Pass null to
   * clear the preset while restoring the given ids.
   */
  applySourcePreset: (preset: SourcePresetId | null, enabledIds: string[]) => void
  /** Fetch data sources from API. Only web_search is enabled by default */
  fetchDataSources: (authToken?: string) => Promise<void>
  /** Disable sources that require authentication */
  disableAuthRequiredSources: () => void
  /** Set available data sources (from API) */
  setAvailableDataSources: (sources: DataSourceFromAPI[]) => void
  /** Set knowledge layer availability */
  setKnowledgeLayerAvailable: (available: boolean) => void
  /** Set VLM (vision model) capability availability */
  setVlmAvailable: (available: boolean) => void
  /**
   * @deprecated Use setDataSourcesPanelTab instead
   */
  setDataSourcePanelTab: (tab: DataSourcesPanelTab) => void
}

/** Combined layout store type */
export type LayoutStore = LayoutState & LayoutActions
