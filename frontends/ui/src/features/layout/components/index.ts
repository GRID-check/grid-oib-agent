/**
 * Layout Components Barrel Export
 */

// Main layout components
export { MainLayout } from './MainLayout'
export { SessionsPanel } from './SessionsPanel'
export { ChatArea } from './ChatArea'
export { InputArea } from './InputArea'

// Research panel and tabs
export { ResearchPanel } from './ResearchPanel'
export { TasksTab } from './TasksTab'
export { ThinkingTab } from './ThinkingTab'
export { ReportTab } from './ReportTab'

// Thinking sub-tabs and cards
export { AgentsTab } from './AgentsTab'
export { AgentCard } from './AgentCard'
export type { AgentInfo } from './AgentCard'
export { ToolCallsTab } from './ToolCallsTab'
export { ToolCallCard } from './ToolCallCard'
export type { ToolCallInfo } from './ToolCallCard'
export { ThoughtTracesTab } from './ThoughtTracesTab'
export { ThoughtCard } from './ThoughtCard'
export type { ThoughtInfo } from './ThoughtCard'
export { FilesTab } from './FilesTab'
export { FileCard } from './FileCard'
export type { FileInfo } from './FileCard'

// Citations components
export { SourceCard } from './SourceCard'
export type { SourceInfo } from './SourceCard'

// Report components
export { ReportCard } from './ReportCard'
export { ExportFooter } from './ExportFooter'

// Data sources tabs and cards (reused by the composer sources popover)
export { DataConnectionCard } from './DataConnectionCard'
export { FileSourcesTab } from './FileSourcesTab'
export { FileSourceCard } from './FileSourceCard'

// Confirmation modals
export { DeleteFileConfirmationModal } from './DeleteFileConfirmationModal'
export { DeleteSessionConfirmationModal } from './DeleteSessionConfirmationModal'
