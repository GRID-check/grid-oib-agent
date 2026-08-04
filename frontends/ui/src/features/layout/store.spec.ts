/**
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useLayoutStore } from './store'

const mockGetDataSources = vi.hoisted(() => vi.fn())

vi.mock('@/adapters/api', () => ({
  createDataSourcesClient: vi.fn(() => ({
    getDataSources: mockGetDataSources,
  })),
}))

describe('useLayoutStore', () => {
  beforeEach(() => {
    mockGetDataSources.mockReset()
    // Reset store to initial state before each test (matches store.ts initialState)
    useLayoutStore.setState({
      isSessionsPanelOpen: false,
      rightPanel: null,
      researchPanelTab: 'tasks',
      dataSourcesPanelTab: 'connections',
      enabledDataSourceIds: [],
      theme: 'system',
      availableDataSources: null,
      knowledgeLayerAvailable: false,
      dataSourcesLoading: false,
      dataSourcesError: null,
      deepResearchIntent: false,
      activeSourcePreset: null,
    })
  })

  describe('initial state', () => {
    test('has correct default values', () => {
      const state = useLayoutStore.getState()

      expect(state.isSessionsPanelOpen).toBe(false)
      expect(state.rightPanel).toBeNull()
      expect(state.researchPanelTab).toBe('tasks')
      expect(state.dataSourcesPanelTab).toBe('connections')
    })
  })

  describe('toggleSessionsPanel', () => {
    test('opens sessions panel when closed', () => {
      useLayoutStore.getState().toggleSessionsPanel()

      expect(useLayoutStore.getState().isSessionsPanelOpen).toBe(true)
    })

    test('closes sessions panel when open', () => {
      useLayoutStore.setState({ isSessionsPanelOpen: true })

      useLayoutStore.getState().toggleSessionsPanel()

      expect(useLayoutStore.getState().isSessionsPanelOpen).toBe(false)
    })

    test('toggles multiple times correctly', () => {
      const { toggleSessionsPanel } = useLayoutStore.getState()

      toggleSessionsPanel()
      expect(useLayoutStore.getState().isSessionsPanelOpen).toBe(true)

      toggleSessionsPanel()
      expect(useLayoutStore.getState().isSessionsPanelOpen).toBe(false)

      toggleSessionsPanel()
      expect(useLayoutStore.getState().isSessionsPanelOpen).toBe(true)
    })
  })

  describe('setSessionsPanelOpen', () => {
    test('sets sessions panel to open', () => {
      useLayoutStore.getState().setSessionsPanelOpen(true)

      expect(useLayoutStore.getState().isSessionsPanelOpen).toBe(true)
    })

    test('sets sessions panel to closed', () => {
      useLayoutStore.setState({ isSessionsPanelOpen: true })

      useLayoutStore.getState().setSessionsPanelOpen(false)

      expect(useLayoutStore.getState().isSessionsPanelOpen).toBe(false)
    })
  })

  describe('openRightPanel', () => {
    test('opens research panel', () => {
      useLayoutStore.getState().openRightPanel('research')

      expect(useLayoutStore.getState().rightPanel).toBe('research')
    })

    test('closing clears the panel', () => {
      useLayoutStore.setState({ rightPanel: 'research' })

      useLayoutStore.getState().closeRightPanel()

      expect(useLayoutStore.getState().rightPanel).toBeNull()
    })
  })

  describe('closeRightPanel', () => {
    test('closes open panel', () => {
      useLayoutStore.setState({ rightPanel: 'research' })

      useLayoutStore.getState().closeRightPanel()

      expect(useLayoutStore.getState().rightPanel).toBeNull()
    })

    test('handles closing when already closed', () => {
      useLayoutStore.setState({ rightPanel: null })

      useLayoutStore.getState().closeRightPanel()

      expect(useLayoutStore.getState().rightPanel).toBeNull()
    })
  })

  describe('setResearchPanelTab', () => {
    test('sets thinking tab', () => {
      useLayoutStore.getState().setResearchPanelTab('thinking')

      expect(useLayoutStore.getState().researchPanelTab).toBe('thinking')
    })

    test('sets report tab', () => {
      useLayoutStore.setState({ researchPanelTab: 'thinking' })

      useLayoutStore.getState().setResearchPanelTab('report')

      expect(useLayoutStore.getState().researchPanelTab).toBe('report')
    })
  })

  describe('setDataSourcesPanelTab', () => {
    test('sets connections tab', () => {
      useLayoutStore.setState({ dataSourcesPanelTab: 'files' })

      useLayoutStore.getState().setDataSourcesPanelTab('connections')

      expect(useLayoutStore.getState().dataSourcesPanelTab).toBe('connections')
    })

    test('sets files tab', () => {
      useLayoutStore.getState().setDataSourcesPanelTab('files')

      expect(useLayoutStore.getState().dataSourcesPanelTab).toBe('files')
    })
  })

  describe('setTheme', () => {
    test('sets light theme', () => {
      useLayoutStore.getState().setTheme('light')

      expect(useLayoutStore.getState().theme).toBe('light')
    })

    test('sets dark theme', () => {
      useLayoutStore.getState().setTheme('dark')

      expect(useLayoutStore.getState().theme).toBe('dark')
    })

    test('sets system theme', () => {
      useLayoutStore.setState({ theme: 'dark' })

      useLayoutStore.getState().setTheme('system')

      expect(useLayoutStore.getState().theme).toBe('system')
    })
  })

  describe('setDeepResearchIntent', () => {
    test('records the intent hint on and off', () => {
      useLayoutStore.getState().setDeepResearchIntent(true)
      expect(useLayoutStore.getState().deepResearchIntent).toBe(true)

      useLayoutStore.getState().setDeepResearchIntent(false)
      expect(useLayoutStore.getState().deepResearchIntent).toBe(false)
    })
  })

  describe('applySourcePreset', () => {
    test('sets the preset and its enabled ids together', () => {
      useLayoutStore.getState().applySourcePreset('law', ['ris'])

      expect(useLayoutStore.getState().activeSourcePreset).toBe('law')
      expect(useLayoutStore.getState().enabledDataSourceIds).toEqual(['ris'])
    })

    test('clears the preset while restoring the given ids', () => {
      useLayoutStore.getState().applySourcePreset('law', ['ris'])

      useLayoutStore.getState().applySourcePreset(null, ['web_search', 'ris'])

      expect(useLayoutStore.getState().activeSourcePreset).toBeNull()
      expect(useLayoutStore.getState().enabledDataSourceIds).toEqual(['web_search', 'ris'])
    })

    test('a manual per-source toggle leaves the preset behind', () => {
      useLayoutStore.getState().applySourcePreset('law', ['ris'])

      useLayoutStore.getState().toggleDataSource('web_search')

      expect(useLayoutStore.getState().activeSourcePreset).toBeNull()
      expect(useLayoutStore.getState().enabledDataSourceIds).toEqual(['ris', 'web_search'])
    })

    test('a manual bulk selection leaves the preset behind', () => {
      useLayoutStore.getState().applySourcePreset('law', ['ris'])

      useLayoutStore.getState().setEnabledDataSources([])

      expect(useLayoutStore.getState().activeSourcePreset).toBeNull()
      expect(useLayoutStore.getState().enabledDataSourceIds).toEqual([])
    })
  })

  describe('fetchDataSources', () => {
    test('enables all returned sources by default', async () => {
      mockGetDataSources.mockResolvedValueOnce({
        data_sources: [
          { id: 'web_search', name: 'Web Search', requires_auth: false },
          { id: 'knowledge_base', name: 'Knowledge Base', requires_auth: true },
        ],
        knowledge_layer: true,
        vlm_available: false,
      })

      await useLayoutStore.getState().fetchDataSources('token-1')

      expect(useLayoutStore.getState().enabledDataSourceIds).toEqual([
        'web_search',
        'knowledge_base',
      ])
      expect(useLayoutStore.getState().knowledgeLayerAvailable).toBe(true)
    })

    test('maps vlm_available from the response into the store', async () => {
      mockGetDataSources.mockResolvedValueOnce({
        data_sources: [{ id: 'web_search', name: 'Web Search', requires_auth: false }],
        knowledge_layer: true,
        vlm_available: true,
      })

      expect(useLayoutStore.getState().vlmAvailable).toBe(false)
      await useLayoutStore.getState().fetchDataSources('token-1')
      expect(useLayoutStore.getState().vlmAvailable).toBe(true)
    })

    test('a fresh fetch clears any active source preset (all sources re-enabled)', async () => {
      useLayoutStore.getState().applySourcePreset('law', ['ris'])
      mockGetDataSources.mockResolvedValueOnce({
        data_sources: [
          { id: 'web_search', name: 'Web Search', requires_auth: false },
          { id: 'ris', name: 'RIS', requires_auth: false },
        ],
        knowledge_layer: true,
        vlm_available: false,
      })

      await useLayoutStore.getState().fetchDataSources('token-1')

      expect(useLayoutStore.getState().activeSourcePreset).toBeNull()
      expect(useLayoutStore.getState().enabledDataSourceIds).toEqual(['web_search', 'ris'])
    })
  })
})
