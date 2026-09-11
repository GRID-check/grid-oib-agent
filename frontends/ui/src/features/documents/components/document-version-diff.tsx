'use client'

/**
 * What changed between two versions of a document, line by line.
 *
 * ## Why this replaced the side-by-side
 *
 * „Was hat sich geändert" is the entire review gesture, and the panel used to
 * answer it with two texts and a note saying differences are not marked. That
 * note was honest — the repository carried no diff implementation, and pairing
 * rows by index is wrong the moment a line is inserted — but it left the reader
 * doing the comparison by eye on a twelve-page Aktenvermerk. The alignment now
 * comes from `diff` (jsdiff) through `lib/documents/version-diff`, so this file
 * has one job: showing rows somebody can read.
 *
 * ## Why there is no red and no green
 *
 * The design language spends chroma on exactly one thing — provenance — and an
 * editorial change is not provenance (`docs/design/grid-design-language.md`:
 * "Provenance signals are the only chroma"). It is the same reasoning that
 * keeps `document-version-badge.tsx` monochrome, and the same conclusion: a
 * green wash here would read as a source signal and would collide with
 * „Projektwissen" three centimetres away.
 *
 * So the difference is carried by SHAPE, three ways at once, because any one of
 * them alone fails somebody:
 *
 *   - a left rule — solid ink for an added line, dashed and quiet for a removed
 *     one. Solid means it is there; dashed means it is gone. Legible in a
 *     monochrome print and in the committed screenshots;
 *   - a `+` / `−` marker in the gutter, which is the convention every reader of
 *     a patch already has;
 *   - ink weight: an added line is body ink, a removed line is muted.
 *
 * Each changed row also carries an `sr-only` word, so nothing here depends on
 * seeing a glyph.
 *
 * ## Why line numbers on both sides
 *
 * They are the reason the diff is trustworthy: after an insert the two columns
 * disagree, and seeing them disagree is what tells the reader the alignment is
 * real rather than positional. They fold away under `sm` where they would cost
 * more width than they buy.
 */

import { useMemo } from 'react'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations, type Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import { DIFF_MAX_ROWS, diffVersionText, type DiffRow } from '@/lib/documents/version-diff'

export interface DocumentVersionDiffProps {
  /** The older version: its number, and its text. */
  from: { versionNumber: number; content: string }
  /** The newer version. */
  to: { versionNumber: number; content: string }
  className?: string
}

/** Per-kind chrome. One place, so a row cannot be styled two ways. */
const ROW_STYLES = {
  added: 'border-foreground bg-accent text-foreground',
  removed: 'border-muted-foreground/70 border-dashed bg-surface-sunken text-muted-foreground',
  // Unchanged lines keep the container's own ground, so the two fills above are
  // the only ones on screen and both read as a mark rather than as a material.
  context: 'border-transparent text-muted-foreground',
} as const satisfies Record<'added' | 'removed' | 'context', string>

const MARKERS = { added: '+', removed: '−', context: ' ' } as const

export function DocumentVersionDiff({ from, to, className }: DocumentVersionDiffProps): JSX.Element {
  const t = useTranslations('files')
  // Diffing is O(n·d) over two whole documents, and the panel re-renders on
  // every unrelated state change in the version list above it.
  const diff = useMemo(() => diffVersionText(from.content, to.content), [from.content, to.content])

  return (
    <section className={cn('space-y-1.5', className)} data-testid="document-version-diff">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <SectionLabel as="h4">{t('lifecycle.versions.diff.heading')}</SectionLabel>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {t('lifecycle.versions.diff.between', {
            from: from.versionNumber,
            to: to.versionNumber,
          })}
        </span>
        <span className="flex-1" />
        {!diff.identical && (
          <span
            className="text-muted-foreground text-[11px] tabular-nums"
            data-testid="document-version-diff-counts"
          >
            {t('lifecycle.versions.diff.added', { count: diff.added })} ·{' '}
            {t('lifecycle.versions.diff.removed', { count: diff.removed })}
          </span>
        )}
      </div>

      {diff.identical ? (
        <p className="text-muted-foreground text-[11px]" data-testid="document-version-diff-identical">
          {t('lifecycle.versions.diff.identical')}
        </p>
      ) : (
        <ol
          className="bg-card max-h-80 overflow-auto rounded-lg border py-1 font-mono text-[11px] leading-[1.6]"
          data-testid="document-version-diff-rows"
        >
          {diff.rows.map((row, index) => (
            <DiffRowItem key={index} row={row} t={t} />
          ))}
        </ol>
      )}

      {diff.truncated && (
        <p className="text-muted-foreground text-[11px]" data-testid="document-version-diff-truncated">
          {t('lifecycle.versions.diff.truncated', { count: DIFF_MAX_ROWS })}
        </p>
      )}
    </section>
  )
}

function DiffRowItem({ row, t }: { row: DiffRow; t: Translator }): JSX.Element {
  if (row.kind === 'gap') {
    return (
      <li
        className="text-muted-foreground/70 flex items-center gap-2 px-2 py-1 select-none"
        data-testid="document-version-diff-gap"
      >
        <span aria-hidden className="border-border flex-1 border-t border-dashed" />
        <span className="shrink-0 text-[10px] tabular-nums">
          {t('lifecycle.versions.diff.gap', { count: row.skipped })}
        </span>
        <span aria-hidden className="border-border flex-1 border-t border-dashed" />
      </li>
    )
  }

  const changed = row.kind !== 'context'
  return (
    <li
      className={cn('flex min-w-0 gap-2 border-l-2 px-2', ROW_STYLES[row.kind])}
      data-testid="document-version-diff-row"
      data-kind={row.kind}
    >
      {/* Both line numbers, so an insert visibly pushes one column past the
          other. Hidden on a phone, where the text needs the width more. */}
      <span aria-hidden className="text-muted-foreground/50 hidden w-14 shrink-0 tabular-nums sm:inline-block">
        <span className="inline-block w-6 text-right">{row.fromLine ?? ''}</span>
        <span className="inline-block w-8 text-right">{row.toLine ?? ''}</span>
      </span>
      <span aria-hidden className="w-2 shrink-0 select-none">
        {MARKERS[row.kind]}
      </span>
      {changed && (
        <span className="sr-only">
          {t(`lifecycle.versions.diff.${row.kind === 'added' ? 'addedLine' : 'removedLine'}`)}:{' '}
        </span>
      )}
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</span>
    </li>
  )
}
