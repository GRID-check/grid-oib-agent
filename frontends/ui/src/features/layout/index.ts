/**
 * Layout Feature Public API
 *
 * Exports all layout components and state management.
 */

// Main layout components
export {
  MainLayout,
  SessionsPanel,
  ChatArea,
  InputArea,
} from './components'

// Research panel and related components
export {
} from './components'

// Thinking sub-tabs and cards
export {
} from './components'
export type { FileInfo } from './components'

// Data sources tabs and cards (reused by the composer sources popover)
export {
  FileSourcesTab,
  FileSourceCard,
} from './components'

// Confirmation modals
export {
  DeleteFileConfirmationModal,
  DeleteSessionConfirmationModal,
} from './components'

// Data Sources Types
export type { DataSource, DataSourceCategory } from './data-sources'

// Store
export { useLayoutStore } from './store'

// Types
export type {
  LayoutState,
  LayoutActions,
  LayoutStore,
  DataSourcesPanelTab,
  ThemeMode,
} from './types'
