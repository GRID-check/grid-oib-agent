/**
 * Chat Components
 *
 * Reusable components for the chat feature.
 */

// Message components
export { UserMessage } from './UserMessage'
export type { UserMessageProps } from './UserMessage'

export { AgentPrompt } from './AgentPrompt'
export type { AgentPromptProps, PromptType } from './AgentPrompt'

export { AgentResponse } from './AgentResponse'
export type { AgentResponseProps } from './AgentResponse'

export { AnswerFeedback } from './AnswerFeedback'
export type { AnswerFeedbackProps } from './AnswerFeedback'

// Banner components
export { ErrorBanner } from './ErrorBanner'
export type { ErrorBannerProps, ErrorCode } from './ErrorBanner'

export { DeepResearchBanner } from './DeepResearchBanner'
export type { DeepResearchBannerProps } from './DeepResearchBanner'

export { NoSourcesBanner } from './NoSourcesBanner'

// Mounted projects, said out loud in the transcript (ADR-0054).
export {
  MountNotice,
  MountCapNotice,
  MountExcludedNotice,
  MountRefusedNotice,
  MountSkippedNotice,
} from './MountNotice'
export type {
  MountNoticeProps,
  MountNoticeReason,
  MountExcludedNoticeProps,
  MountSkippedNoticeProps,
} from './MountNotice'
export { MountNotices } from './MountNotices'

// Thinking/status components
export { ChatThinking } from './ChatThinking'
export type { ChatThinkingProps } from './ChatThinking'
