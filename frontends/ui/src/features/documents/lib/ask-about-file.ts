/**
 * From a file into the project chat. The file comes with you as a peek.
 * The user types the question; retrieval is told the filename separately.
 */

import { useChatStore } from '@/features/chat'
import type { DraftMention } from '@/features/collaboration/lib/mention-text'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileItem } from '../components/project-file-workspace'
import { documentAskQuestion, documentQuestionHref } from './document-question'
import { useFilePreviewStore } from '../stores/file-preview-store'

export { documentAskQuestion }

export function askAboutFile(options: {
  projectId: string
  file: FileItem
  ask?: string
  mentions?: DraftMention[]
  navigate: (href: string) => void
}): void {
  const name = documentDisplayName(options.file)
  const ask = options.ask?.trim() ?? ''
  const preview = useFilePreviewStore.getState()
  if (preview.file?.id === options.file.id) {
    preview.peek()
  } else {
    preview.open(options.file, 'peek', { projectId: options.projectId, scope: 'files' })
  }

  const chat = useChatStore.getState()
  if (!chat.currentUserId) {
    options.navigate(documentQuestionHref(options.projectId, options.file.id, ask ? { ask } : { filename: options.file.filename }))
    return
  }
  const alreadyThisFile = chat.currentConversation?.subjectResourceId === options.file.id
  if (!alreadyThisFile) {
    chat.startNewSessionDraft()
  }
  chat.setComposerPrefill(ask, options.mentions, {
    resourceType: 'document',
    resourceId: options.file.id,
    title: name,
    filename: options.file.filename,
  })
  options.navigate(`/app/projects/${encodeURIComponent(options.projectId)}/chat`)
}
