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
  ResearchPanel,
  TasksTab,
  ThinkingTab,
  ReportTab,
  ReportCard,
  ExportFooter,
} from './components'

// Thinking sub-tabs and cards
export {
  AgentsTab,
  AgentCard,
  ToolCallsTab,
  ToolCallCard,
  ThoughtTracesTab,
  ThoughtCard,
  FilesTab,
  SourceCard,
} from './components'
export type { AgentInfo } from './components'
export type { ToolCallInfo } from './components'
export type { ThoughtInfo } from './components'
export type { FileInfo } from './components'
export type { SourceInfo } from './components'

// Data sources tabs and cards (reused by the composer sources popover)
export {
  DataConnectionCard,
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
  RightPanelType,
  ResearchPanelTab,
  DataSourcesPanelTab,
  ThemeMode,
} from './types'
