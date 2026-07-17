/**
 * Layout Store
 *
 * Zustand store for managing the main app layout state.
 * Controls sidebar visibility and panel states.
 */

import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type {
  LayoutState,
  LayoutStore,
  RightPanelType,
  ResearchPanelTab,
  DataSourcesPanelTab,
  SourcePresetId,
  ThemeMode,
} from './types'
import { createDataSourcesClient, type DataSourceFromAPI } from '@/adapters/api'

const initialState: LayoutState = {
  isSessionsPanelOpen: false,
  rightPanel: 'data-sources',
  researchPanelTab: 'tasks',
  dataSourcesPanelTab: 'connections',
  enabledDataSourceIds: [], // Start empty, populated when data sources are fetched
  theme: 'system',
  availableDataSources: null,
  knowledgeLayerAvailable: false, // Default to false until API confirms availability
  vlmAvailable: false, // Default to false until API confirms the VLM capability
  dataSourcesLoading: false,
  dataSourcesError: null,
  deepResearchIntent: false,
  activeSourcePreset: null,
  // Deprecated aliases for backwards compatibility
  detailsPanelTab: 'report',
  dataSourcePanelTab: 'connections',
}

export const useLayoutStore = create<LayoutStore>()(
  devtools(
    persist(
      (set) => ({
        ...initialState,

      toggleSessionsPanel: () =>
        set(
          (state) => ({ isSessionsPanelOpen: !state.isSessionsPanelOpen }),
          false,
          'toggleSessionsPanel'
        ),

      setSessionsPanelOpen: (open: boolean) =>
        set({ isSessionsPanelOpen: open }, false, 'setSessionsPanelOpen'),

      openRightPanel: (panel: RightPanelType) =>
        set({ rightPanel: panel }, false, 'openRightPanel'),

      closeRightPanel: () => set({ rightPanel: null }, false, 'closeRightPanel'),

      setResearchPanelTab: (tab: ResearchPanelTab) =>
        set({ researchPanelTab: tab }, false, 'setResearchPanelTab'),

      setDataSourcesPanelTab: (tab: DataSourcesPanelTab) =>
        set({ dataSourcesPanelTab: tab }, false, 'setDataSourcesPanelTab'),

      toggleDataSource: (id: string) =>
        set(
          (state) => {
            const isEnabled = state.enabledDataSourceIds.includes(id)
            return {
              enabledDataSourceIds: isEnabled
                ? state.enabledDataSourceIds.filter((sourceId) => sourceId !== id)
                : [...state.enabledDataSourceIds, id],
              // Manual toggling takes the user off any shortcut preset.
              activeSourcePreset: null,
            }
          },
          false,
          'toggleDataSource'
        ),

      setEnabledDataSources: (ids: string[]) =>
        // Bulk manual selection also leaves any shortcut preset behind;
        // applySourcePreset is the one action that sets both together.
        set({ enabledDataSourceIds: ids, activeSourcePreset: null }, false, 'setEnabledDataSources'),

      setTheme: (theme: ThemeMode) => set({ theme }, false, 'setTheme'),

      setDeepResearchIntent: (on: boolean) =>
        set({ deepResearchIntent: on }, false, 'setDeepResearchIntent'),

      applySourcePreset: (preset: SourcePresetId | null, enabledIds: string[]) =>
        set(
          { activeSourcePreset: preset, enabledDataSourceIds: enabledIds },
          false,
          'applySourcePreset'
        ),

      fetchDataSources: async (authToken?: string) => {
        set({ dataSourcesLoading: true, dataSourcesError: null }, false, 'fetchDataSources/start')

        try {
          const client = createDataSourcesClient({ authToken })
          const response = await client.getDataSources()

          // Start with every returned source enabled. Auth-aware cleanup still
          // runs through disableAuthRequiredSources when a user loses access.
          const enabledIds = response.data_sources.map((source) => source.id)

          set(
            {
              availableDataSources: response.data_sources,
              knowledgeLayerAvailable: response.knowledge_layer,
              vlmAvailable: response.vlm_available,
              enabledDataSourceIds: enabledIds,
              // Fresh fetch enables everything — that's manual-equivalent
              // state, so no shortcut preset can be considered active.
              activeSourcePreset: null,
              dataSourcesLoading: false,
              dataSourcesError: null,
            },
            false,
            'fetchDataSources/success'
          )
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch data sources'
          set(
            {
              dataSourcesLoading: false,
              dataSourcesError: errorMessage,
            },
            false,
            'fetchDataSources/error'
          )
        }
      },

      disableAuthRequiredSources: () =>
        set(
          (state) => ({
            enabledDataSourceIds: state.enabledDataSourceIds.filter((id) => {
              const source = state.availableDataSources?.find((s) => s.id === id)
              return !source?.requires_auth
            }),
          }),
          false,
          'disableAuthRequiredSources'
        ),

      setAvailableDataSources: (sources: DataSourceFromAPI[]) =>
        set({ availableDataSources: sources }, false, 'setAvailableDataSources'),

      setKnowledgeLayerAvailable: (available: boolean) =>
        set({ knowledgeLayerAvailable: available }, false, 'setKnowledgeLayerAvailable'),

      setVlmAvailable: (available: boolean) =>
        set({ vlmAvailable: available }, false, 'setVlmAvailable'),

      // Deprecated actions - delegate to new ones
      setDetailsPanelTab: (tab: ResearchPanelTab) =>
        set(
          { researchPanelTab: tab, detailsPanelTab: tab },
          false,
          'setDetailsPanelTab'
        ),

      setDataSourcePanelTab: (tab: DataSourcesPanelTab) =>
        set(
          { dataSourcesPanelTab: tab, dataSourcePanelTab: tab },
          false,
          'setDataSourcePanelTab'
        ),
    }),
      {
        name: 'grid-layout',
        // Only explicit user preferences survive reloads (theme + the
        // Deep-Research intent hint) — panel/tab/data-source state stays
        // ephemeral per session.
        partialize: (state) => ({
          theme: state.theme,
          deepResearchIntent: state.deepResearchIntent,
        }),
      }
    ),
    { name: 'LayoutStore' }
  )
)
