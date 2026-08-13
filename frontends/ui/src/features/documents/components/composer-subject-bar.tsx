'use client'

/**
 * The composer’s statement that this Ask Piloti turn is about a file.
 *
 * Not a second chat. Same box, same send, same agent — the bar is the
 * consequence of arriving via `?ask=` + `?doc=`, the way InvokedSkillChip is
 * the consequence of typing `/name`. Removing it drops the focus, not the
 * thread: the next send is a normal project question again.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { FileText, X } from 'lucide-react'
import { AnimatePresence, motion, easeQuiet } from '@/components/motion'
import { useTranslations } from '@/i18n'
import { sourceBase, sourceTint } from '@/lib/ui/source-tint'
import type { ComposerSubject } from '@/features/chat/types'
import { documentFilesHref } from '../lib/document-question'

export function ComposerSubjectBar({
  subject,
  projectId,
  onClear,
  onTitle,
  onShowFile,
}: {
  subject: ComposerSubject | null
  projectId: string | null
  onClear: () => void
  onTitle: (title: string) => void
  onShowFile?: () => void
}): JSX.Element {
  const t = useTranslations('files')

  useEffect(() => {
    if (!subject || subject.title) return
    let cancelled = false
    fetch(`/api/documents/${encodeURIComponent(subject.resourceId)}/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { filename?: string; displayName?: string | null } | null) => {
        if (cancelled || !body) return
        const title = body.displayName?.trim() || body.filename?.trim()
        if (title) onTitle(title)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [subject, onTitle])

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
          transition={easeQuiet}
          className="mb-2 flex items-start gap-2.5 rounded-lg border px-2.5 py-2"
          style={sourceTint('project')}
        >
          <span
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-background/70"
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
            <span className="text-[11px] leading-snug opacity-80">{t('assignment.subjectHint')}</span>
          </span>
          {onShowFile && (
            <button
              type="button"
              onClick={onShowFile}
              className="text-muted-foreground hover:text-foreground shrink-0 rounded-md px-1.5 py-1 text-[11px]"
            >
              {t('assignment.showFile')}
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            aria-label={t('assignment.subjectClear')}
            className="focus-visible:ring-ring/60 text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1 transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
