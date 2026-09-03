'use client'

/**
 * The composer’s statement that this Ask Piloti turn is about a file.
 *
 * Not a second chat. Same box, same send, same agent — the bar is the
 * consequence of arriving via `?ask=` + `?doc=`, the way InvokedSkillChip is
 * the consequence of typing `/name`. Removing it drops the focus, not the
 * thread: the next send is a normal project question again.
 */

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { FileText, X } from 'lucide-react'
import { AnimatePresence, motion, motionEntrance } from '@/components/motion'
import { useTranslations } from '@/i18n'
import { sourceBase, sourceTint } from '@/lib/ui/source-tint'
import type { ComposerSubject } from '@/features/chat/types'
import { documentFilesHref } from '../lib/document-question'

/** Shelves a composer subject can sit on; `documents.scope` uses these names. */
const SUBJECT_SHELVES = ['project', 'archiv', 'session'] as const

/** The fields of `/api/documents/[id]/status` this bar reads. */
interface DocumentSubjectStatus {
  filename?: string
  displayName?: string | null
  scope?: string | null
}

/** What the status lookup recovered for a subject restored from an id alone. */
export interface ResolvedSubjectIdentity {
  title: string | null
  filename: string | null
  shelf?: ComposerSubject['shelf']
}

export function ComposerSubjectBar({
  subject,
  projectId,
  onClear,
  onResolved,
  onShowFile,
}: {
  subject: ComposerSubject | null
  projectId: string | null
  onClear: () => void
  onResolved: (identity: ResolvedSubjectIdentity) => void
  onShowFile?: () => void
}): JSX.Element {
  const t = useTranslations('files')

  /*
    Recover what a restored subject cannot carry.

    A conversation persists only the subject's resource id, so after a reload
    the bar is handed an id and nothing else — no stored filename (which IS the
    retrieval identity sent as `focus_file_name`) and no shelf. Asking the
    document for them beats writing a copy onto the conversation: a copy would
    also have to be kept in step with a rename, and the row is the authority
    either way.

    The guard is "anything missing", not "no title": a subject restored with a
    title but no filename used to skip this fetch entirely and send the title
    as the filename.

    It is keyed on the SUBJECT and nothing else. The caller's handler is held in
    a ref rather than a dependency because a composer re-renders on every
    keystroke, and it is attempted once per resource because a document that
    404s (deleted, or no longer readable) never completes the subject — between
    them, the widened guard above would otherwise mean one request per
    keystroke for as long as the bar is mounted.
  */
  const onResolvedRef = useRef(onResolved)
  useEffect(() => {
    onResolvedRef.current = onResolved
  }, [onResolved])

  const attemptedRef = useRef<string | null>(null)
  const resourceId = subject?.resourceId ?? null
  const isComplete = Boolean(subject?.title && subject?.filename && subject?.shelf)

  useEffect(() => {
    if (!resourceId || isComplete) return
    if (attemptedRef.current === resourceId) return
    attemptedRef.current = resourceId
    let cancelled = false
    fetch(`/api/documents/${encodeURIComponent(resourceId)}/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: DocumentSubjectStatus | null) => {
        if (cancelled || !body) return
        const filename = body.filename?.trim() || null
        const title = body.displayName?.trim() || filename
        const shelf = SUBJECT_SHELVES.find((value) => value === body.scope)
        if (title || filename || shelf) onResolvedRef.current({ title, filename, shelf })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [resourceId, isComplete])

  const name = subject?.title?.trim() || t('assignment.thisFile')
  const href = subject && projectId ? documentFilesHref(projectId, subject.resourceId) : null

  return (
    <AnimatePresence initial={false}>
      {subject && (
        <motion.div
          key={subject.resourceId}
          data-testid="composer-subject-bar"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={motionEntrance}
          className="mb-2 flex items-start gap-2.5 rounded-lg border px-2.5 py-2"
          style={sourceTint('project')}
        >
          <span
            // Plain classes standing in for `StatCardIcon` (dense + bordered):
            // that atom has not landed on this branch yet, and this well
            // already carries its spec — size-7, rounded-lg, bordered card
            // ground with the shelf tint as ink.
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card"
            aria-hidden
          >
            <FileText className="size-3.5" style={{ color: sourceBase('project') }} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-xs leading-snug">
              <span className="text-muted-foreground">{t('assignment.askingAboutPrefix')}</span>{' '}
              {href ? (
                <Link
                  href={href}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {name}
                </Link>
              ) : (
                <span className="font-medium">{name}</span>
              )}
            </span>
            <span className="text-xs leading-snug opacity-80">{t('assignment.subjectHint')}</span>
          </span>
          {onShowFile && (
            <button
              type="button"
              // The peek hands focus here when the reader dismisses it — this
              // is the undo for the move they just made. See `PeekToolbar`.
              data-testid="composer-show-file"
              onClick={onShowFile}
              // 24px, sitting directly beside the clear button below — the two
              // controls of this bar grow rather than overhang so a tap on one
              // cannot be taken by the other.
              className="text-muted-foreground hover:text-foreground shrink-0 rounded-md px-1.5 py-1 text-xs pointer-coarse:min-h-11 pointer-coarse:px-3"
            >
              {t('assignment.showFile')}
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            aria-label={t('assignment.subjectClear')}
            // "Stop asking about this file" — 22px, and the one control that
            // undoes the bar it lives in.
            className="focus-visible:ring-ring/60 text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1 transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 pointer-coarse:inline-flex pointer-coarse:size-11 pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:p-0"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
