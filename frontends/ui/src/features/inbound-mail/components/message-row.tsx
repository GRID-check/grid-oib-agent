'use client'

/**
 * The mail's own text as a part to file: a checkbox, and where it goes.
 *
 * A filed text is a section of an E-Mail-Verlauf, one document per
 * conversation, and each filed mail adds a Fassung. So the choice is which
 * thread: one the server recognised and pre-selected (D11: only a signed
 * reference from a confirmed domain earns that), another candidate offered
 * unchecked with the reason it is not pre-selected, or a new thread whose name
 * the person confirms. Appending where the sender could not vouch for the
 * reference needs the person's yes („Gehört trotzdem zu diesem
 * E-Mail-Verlauf“). Threads the viewer may not read are counted, never named.
 */

import type { JSX } from 'react'
import { useId, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FolderInput, Mail, MailCheck, Repeat2 } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FilingChip } from '@/components/ui/filing-chip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { FolderPickerSheet } from '@/features/documents/components/folder-picker-sheet'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { useTranslations } from '@/i18n'
import { INBOUND_MAIL_FILE_NAME_MAX, type InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'
import { cn } from '@/lib/utils'
import {
  appendNeedsAcknowledgement,
  messageSelectable,
  newThreadTarget,
  targetForPath,
  type DraftCopy,
  type FolderOption,
  type MessageDraft,
} from '../lib/draft'
import { folderLeaf } from '../lib/suggestion'
import { CheckLine, FactLine } from './inbound-mail-atoms'

const NEW_THREAD = 'new'

export interface MessageRowProps {
  projectId: string
  view: InboundMailView
  draft: MessageDraft
  folders: readonly FolderOption[]
  copy: DraftCopy
  /** The thread name was stopped by the name check (a `name_stop` refusal): offer „Trotzdem ablegen“. */
  threadNameStopped: boolean
  onChange: (change: Partial<Omit<MessageDraft, 'partId'>>) => void
}

export function MessageRow({ projectId, view, draft, folders, copy, threadNameStopped, onChange }: MessageRowProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const id = useId()
  const [pickerOpen, setPickerOpen] = useState(false)
  const part = view.parts.find((candidate) => candidate.kind === 'message')
  const selectable = messageSelectable(view)
  const alreadyFiled = view.sender?.flags.includes('already_filed') ?? false
  const target = draft.target
  const candidates = view.threadCandidates
  const chosen = target.kind === 'append' ? candidates.find((candidate) => candidate.threadId === target.threadId) : undefined
  const destinations = useMemo(
    () =>
      folders
        .filter((folder) => folder.writable)
        .map((folder) => ({ folder: { id: folder.id, name: folder.name, parentId: folder.parentId }, label: folder.path.split('/').join(' / ') })),
    [folders]
  )

  // A text that is not waiting any more says what became of it.
  if (part && part.state !== 'waiting') {
    return (
      <div className="flex items-start gap-3 px-3 py-3 sm:px-4" data-testid="message-row" data-status={part.state}>
        <Mail className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium">{t('message.label')}</p>
          {part.state === 'filed' ? (
            <FactLine icon={view.followedBy ? Repeat2 : CheckCircle2} tone="default" testId="message-filed">
              {view.followedBy ? t('message.followed') : t('message.filed')}
              {part.documentId && (
                <>
                  {' · '}
                  <Link className="underline-offset-2 hover:underline" href={documentFilesHref(projectId, part.documentId)}>
                    {t('message.openThread')}
                  </Link>
                </>
              )}
            </FactLine>
          ) : (
            <FactLine icon={Mail}>{t(`attachments.status.${part.state}`)}</FactLine>
          )}
        </div>
      </div>
    )
  }

  const choose = (value: string): void => {
    if (value === NEW_THREAD) {
      onChange({ target: target.kind === 'create' ? target : newThreadTarget(view, folders, copy), acknowledgeThread: false })
    } else {
      onChange({ target: { kind: 'append', threadId: value }, acknowledgeThread: false })
    }
  }

  return (
    <div className="flex items-start gap-3 px-3 py-3 sm:px-4" data-testid="message-row" data-checked={draft.checked || undefined}>
      <div className="flex h-5 items-center pointer-coarse:h-11">
        <Checkbox
          checked={selectable && draft.checked}
          disabled={!selectable}
          onCheckedChange={(value) => onChange({ checked: value === true })}
          aria-label={t('message.file')}
          data-testid="message-checkbox"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <MailCheck className="text-muted-foreground size-4" aria-hidden />
          {t('message.label')}
        </p>
        {part?.riskFlags.includes('unreadable') && (
          <FactLine icon={AlertTriangle} tone="warning">
            {t('message.unreadable')}
          </FactLine>
        )}
        {alreadyFiled && <FactLine icon={CheckCircle2}>{t('message.alreadyFiled')}</FactLine>}

        {selectable && draft.checked && (
          <RadioGroup
            value={target.kind === 'append' ? target.threadId : NEW_THREAD}
            onValueChange={choose}
            aria-label={t('message.label')}
            className="gap-2"
            disabled={draft.findingChoice === 'own_thread'}
          >
            {candidates.map((candidate) => (
              <div key={candidate.threadId} className="flex items-start gap-2 pointer-coarse:min-h-11" data-testid={`thread-candidate-${candidate.threadId}`}>
                <RadioGroupItem
                  id={`${id}-${candidate.threadId}`}
                  value={candidate.threadId}
                  disabled={candidate.full}
                  className="mt-0.5"
                />
                <Label htmlFor={`${id}-${candidate.threadId}`} className={cn('flex flex-col items-start gap-0.5 font-normal', candidate.full && 'opacity-60')}>
                  <span className="text-foreground text-sm [overflow-wrap:anywhere]">
                    {t('message.append', { name: candidate.name, version: candidate.nextVersion })}
                  </span>
                  {candidate.full ? (
                    <span className="text-muted-foreground text-xs">{t('message.full')}</span>
                  ) : (
                    candidate.blocks.map((block) => (
                      <span key={block} className={cn('text-xs', block === 'weak_match' ? 'text-muted-foreground' : 'text-foreground font-medium')}>
                        {t(`message.blocks.${block}`)}
                      </span>
                    ))
                  )}
                </Label>
              </div>
            ))}
            <div className="flex items-start gap-2 pointer-coarse:min-h-11">
              <RadioGroupItem id={`${id}-new`} value={NEW_THREAD} className="mt-0.5" data-testid="thread-new" />
              <Label htmlFor={`${id}-new`} className="text-sm font-normal">
                {t('message.create')}
              </Label>
            </div>
          </RadioGroup>
        )}
        {view.hiddenThreadCandidates > 0 && selectable && draft.checked && (
          <p className="text-muted-foreground text-xs">{t('message.hidden', { count: view.hiddenThreadCandidates })}</p>
        )}

        {selectable && draft.checked && chosen && appendNeedsAcknowledgement(chosen) && (
          <CheckLine checked={draft.acknowledgeThread} onCheckedChange={(acknowledgeThread) => onChange({ acknowledgeThread })} testId="thread-acknowledge">
            {t('message.acknowledge')}
          </CheckLine>
        )}

        {selectable && draft.checked && target.kind === 'create' && (
          <div className="flex flex-col gap-2 pl-6" data-testid="thread-create">
            <Label htmlFor={`${id}-name`} className="text-xs">
              {t('message.nameLabel')}
            </Label>
            <Input
              id={`${id}-name`}
              value={target.name}
              maxLength={INBOUND_MAIL_FILE_NAME_MAX}
              onChange={(event) => onChange({ target: { ...target, name: event.target.value } })}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="pointer-coarse:text-base"
              aria-invalid={target.name.trim() === '' || undefined}
              data-testid="thread-name"
            />
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">{t('message.folderLabel')}</span>
              {target.folder.path === '' ? (
                <Button type="button" size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setPickerOpen(true)}>
                  <FolderInput className="size-3.5" aria-hidden />
                  {t('suggestion.root')}
                </Button>
              ) : (
                <FilingChip
                  target={folderLeaf(target.folder.path)}
                  title={target.folder.path}
                  newLabel={target.folder.kind === 'new' ? t('suggestion.newFolder') : undefined}
                  onClick={() => setPickerOpen(true)}
                  className="border-solid"
                />
              )}
            </div>
            {threadNameStopped && (
              <>
                <FactLine icon={AlertTriangle} tone="warning">
                  {t('refusals.name_stop')}
                </FactLine>
                <CheckLine
                  checked={target.releaseName}
                  onCheckedChange={(releaseName) => onChange({ target: { ...target, releaseName } })}
                  testId="thread-release-name"
                >
                  {t('message.releaseName')}
                </CheckLine>
              </>
            )}
          </div>
        )}
      </div>
      <FolderPickerSheet
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t('target.folderPickerTitle')}
        destinations={destinations}
        currentFolderId={target.kind === 'create' && target.folder.kind === 'existing' ? target.folder.folderId : undefined}
        onPick={(folderId) => {
          setPickerOpen(false)
          if (target.kind !== 'create') return
          const folder = folderId ? folders.find((option) => option.id === folderId) : null
          onChange({ target: { ...target, folder: folder ? targetForPath(folder.path, folders, folder.id) : targetForPath('', folders) } })
        }}
      />
    </div>
  )
}
