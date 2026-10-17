'use client'

/**
 * Fassungen und Freigabe: ONE section for what a document has been and where it
 * stands now. It sits in the preview rail, which is 248px of content.
 *
 *  - **The header says where the document stands, in one line**, and is about
 *    the NEWEST Fassung only: „Fassung 2 · In Prüfung", the approval track with
 *    its four stages named, the next step with a person („Nächster Schritt:
 *    Freigabe durch Sabine Gruber"), and which Fassung Piloti answers from. When
 *    that is an older one, the header says so by number („Piloti antwortet
 *    weiter aus Fassung 1."), so the header and the rows below can no longer
 *    contradict each other (`lib/fassung-standing.ts`).
 *  - **The body is one timeline, newest first, numbered „Fassung 3, 2, 1"**
 *    across the uploads under this name (`document_versions`, ADR-0054) and the
 *    older documents linked under other names (ADR-0099). The index or date the
 *    office gave a Fassung is a secondary tag; „aktuell" marks only the one
 *    Piloti answers from (`lib/fassung-timeline.ts`).
 *  - **Every fact once.** The state is in the header; the date and the person
 *    on a row's act line; a file name only where the row is another document.
 *    One visible action per row (Öffnen), the rest behind its ⋯.
 *
 * ## An upload is not a fake approval
 *
 * A person's upload is born published, without a review. It gets no state word
 * and no track, and its act is „Hochgeladen", never „Freigegeben" or
 * „Veröffentlicht". A Fassung a newer document replaced is „Ersetzt", without a
 * green track.
 *
 * ## Shut by default, and it opens itself when something is asked of the reader
 *
 * The header is always visible; the body is a disclosure. It opens ITSELF when a
 * decision is this reader's to take (`lifecycleNeedsReader`), when Piloti has an
 * unconfirmed suggestion, or when this document is an older Fassung. It opens on
 * the attention EDGE, once, so a reader who closes it is not fought.
 *
 * ## Controls only where the surface can honour them
 *
 * Review controls need the reader's lifecycle permissions, which the Files
 * workspace resolves and the Archiv sheet and the chat peek do not. Without
 * `viewer` the same section shows the timeline and the suggestion and no
 * controls. Linking and unlinking is `canManage`, a different permission.
 *
 * Data handling is `useDocumentLifecycle`; this component composes it with the
 * Fassung facts the listing already carries.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, History } from 'lucide-react'
import { toast } from 'sonner'
import type { ActionMenuEntry } from '@/components/ui/action-menu'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { SectionLabel } from '@/components/ui/section-label'
import { InspectorGroup } from '@/components/ui/inspector-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { StageTrack } from '@/components/ui/stage-track'
import { useLocale, useTranslations, type Translator } from '@/i18n'
import { formatDate } from '@/lib/format'
import { distinguishingTailLength } from '@/lib/text/middle-truncate'
import { cn } from '@/lib/utils'
import type { FassungFacts, FassungHistoryEntry } from '@/lib/documents/fassung'
import type { DocumentLifecycleClient } from '@/lib/documents/lifecycle-client'
import { documentLifecycleClient, versionFileUrl } from '@/lib/documents/lifecycle-client'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import { readDocumentText } from '@/lib/documents/text-client'
import { documentReadFamily } from '@/lib/documents/document-status'
import type { FileItem } from '../file-types'
import {
  newestVersion,
  useDocumentLifecycle,
  type DocumentLifecycleSummary,
} from '../hooks/use-document-lifecycle'
import {
  LIFECYCLE_STAGES,
  availableLifecycleGestures,
  canArchiveDocument,
  lifecycleNeedsReader,
  type DocumentLifecycleViewer,
} from '../lib/document-lifecycle'
import { fassungStanding, resolvePerson, type FassungStanding, type NextStep } from '../lib/fassung-standing'
import {
  buildFassungTimeline,
  fassungTag,
  isPendingVersion,
  latestAct,
  numberOfVersion,
  showsFassungenSection,
  versionActs,
  versionContentUrl,
  type FassungTag,
  type HeadRow,
  type LinkedRow,
  type NewerRow,
  type TimelineRow,
  type VersionAct,
  type VersionRow,
} from '../lib/fassung-timeline'
import { requestFassungLink } from '../lib/fassung-request'
import { DocumentArchiveAction } from './document-archive-action'
import { DocumentReviewControls, type DocumentReviewControlsProps } from './document-review-controls'
import { DocumentVersionDiff } from './document-version-diff'
import { DocumentVersionStateBadge } from './document-version-badge'
import { useFassungCompare, type SourceLoader } from './fassung-compare'
import type { CompareFile } from './fassung-compare/types'
import { SuggestionNotice } from './fassung-notices'
import { FassungTimelineRow, RowAction } from './fassung-timeline-row'

export interface DocumentFassungenProps {
  file: FileItem
  /** May this reader link and unlink Fassungen (a write on the folder)? */
  canManage: boolean
  /**
   * What this reader may do to the document's versions. Absent on the surfaces
   * that did not resolve it (the Archiv sheet, the chat peek): the section then
   * shows the timeline and the suggestion, and no review controls.
   */
  viewer?: DocumentLifecycleViewer
  /** Names the pane already knows (the document's assignees), by user id. */
  names?: Readonly<Record<string, string>>
  /** Injected by the dev preview and the specs; the browser gets the real one. */
  client?: DocumentLifecycleClient
  /** Where the visual comparison gets its pages. Injected by the specs and the dev preview. */
  compareSource?: SourceLoader
  /** A link was confirmed or taken back: the facts of BOTH documents, so a listing can move both cards. */
  onFassungChanged?: (fileId: string, fassung: FassungFacts) => void
  /** Open another document of the shelf in this preview: an older Fassung, or the newer one. Absent where the surface cannot. */
  onOpenDocument?: (fileId: string) => void
  /** The document's editorial state changed here, so the listing behind the pane can move its badge. */
  onLifecycleChanged?: (summary: DocumentLifecycleSummary) => void
  /** The document's live Anmerkungen and the way into them, for the approve confirm (`DocumentReviewControls`). */
  openMarks?: DocumentReviewControlsProps['openMarks']
  className?: string
}

/** One side of a text comparison: the number the timeline gives it, and its text. */
interface ComparedText {
  number: number
  content: string
}

type TextComparison =
  | { rowKey: string; status: 'loading' }
  | { rowKey: string; status: 'failed' }
  | { rowKey: string; status: 'done'; from: ComparedText; to: ComparedText }

/** Row states worth a word on an OLDER row. Every older row is replaced; saying „Ersetzt" five times is a stripe, not information. */
const NOTABLE_ROW_STATES: ReadonlySet<DocumentVersionView['state']> = new Set([
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
])

/** The i18n leaf per track stage, in `LIFECYCLE_STAGES` order. */
const STAGE_LABEL_KEYS = [
  'lifecycle.states.draft',
  'lifecycle.states.inReview',
  'lifecycle.states.approved',
  'lifecycle.states.published',
] as const

export function DocumentFassungen({
  file,
  canManage,
  viewer,
  names,
  client = documentLifecycleClient,
  compareSource,
  onFassungChanged,
  onOpenDocument,
  onLifecycleChanged,
  openMarks,
  className,
}: DocumentFassungenProps): JSX.Element | null {
  const t = useTranslations('files')
  const { locale } = useLocale()

  // The rail is reused across files; a decision just made belongs to one.
  const [facts, setFacts] = useState<FassungFacts | null>(file.fassung ?? null)
  const [busy, setBusy] = useState(false)
  // A decision answered after the rail moved to another file belongs to the old one.
  const currentId = useRef(file.id)
  currentId.current = file.id
  useEffect(() => setFacts(file.fassung ?? null), [file.id, file.fassung])

  // The uploads under this very name are read where they can matter: for a
  // reader who may decide on them, and for a document the listing already knows
  // has more than one.
  const lifecycleEnabled = viewer !== undefined || (file.versionCount ?? 1) > 1
  const { listing, loading, failed, pending, reviewers, act } = useDocumentLifecycle({
    documentId: file.id,
    enabled: lifecycleEnabled,
    withReviewers: viewer !== undefined,
    client,
    onChanged: onLifecycleChanged,
  })

  const [textComparison, setTextComparison] = useState<TextComparison | null>(null)
  // The rows of the last render, for the comparison's callback: it runs after
  // the dialog closes, and needs the numbers the reader has just seen.
  const rowsRef = useRef<readonly TimelineRow[]>([])

  /**
   * Two Fassungen that cannot be laid over each other (text, Markdown, CSV):
   * the comparison dialog offers their TEXT instead, and this shows the line
   * comparison under the row it was asked from, the same view the uploads
   * under one name get. Two documents have no shared version chain, so their
   * texts are read one by one (`GET /api/documents/{id}/text`).
   */
  const compareDocumentsAsText = useCallback(
    async (older: CompareFile, newer: CompareFile) => {
      const fileId = file.id
      const other = older.id === fileId ? newer.id : older.id
      const row = rowsRef.current.find(
        (candidate) =>
          (candidate.kind === 'linked' && candidate.entry.id === other) ||
          (candidate.kind === 'newer' && candidate.ref.id === other),
      )
      if (!row) return
      const own = rowsRef.current.find((candidate) => candidate.kind === 'head' || (candidate.kind === 'version' && candidate.newest))
      const numberOf = (id: string) => (id === other ? row.number : (own?.number ?? 0))
      setTextComparison({ rowKey: row.key, status: 'loading' })
      try {
        const [from, to] = await Promise.all([readDocumentText(older.id), readDocumentText(newer.id)])
        if (currentId.current !== fileId) return
        setTextComparison({
          rowKey: row.key,
          status: 'done',
          from: { number: numberOf(older.id), content: from.text },
          to: { number: numberOf(newer.id), content: to.text },
        })
      } catch {
        if (currentId.current === fileId) setTextComparison({ rowKey: row.key, status: 'failed' })
      }
    },
    [file.id],
  )
  const openTextCompare = useCallback(
    (older: CompareFile, newer: CompareFile) => void compareDocumentsAsText(older, newer),
    [compareDocumentsAsText],
  )
  const { openFassungCompare, compareElement } = useFassungCompare(compareSource, { onOpenTextCompare: openTextCompare })

  const supersededBy = facts?.supersededBy ?? null
  const suggestion = facts?.suggestion ?? null
  const changeSummary = facts?.changeSummary ?? null
  const history: readonly FassungHistoryEntry[] =
    facts?.history ?? (facts?.supersedes ?? []).map((ref) => ({ ...ref, createdAt: null, changeSummary: null }))
  const directIds = new Set((facts?.supersedes ?? []).map((ref) => ref.id))

  const versions = listing?.versions ?? []
  const newest = newestVersion(versions)
  const lifecycle = listing?.lifecycle ?? 'active'

  // What the section asks of the reader without being opened.
  const attention =
    suggestion !== null ||
    supersededBy !== null ||
    (viewer !== undefined && listing !== null && lifecycleNeedsReader(newest, lifecycle, viewer))
  const [open, setOpen] = useState(attention)
  // Opens on the attention EDGE, once. Re-asserting `open` on every render
  // would make the disclosure un-closable while a decision is outstanding, and
  // a reader who has read the round and wants the rail back is entitled to it.
  const openedForAttention = useRef(attention)
  useEffect(() => {
    if (!attention || openedForAttention.current) return
    openedForAttention.current = true
    setOpen(true)
  }, [attention])

  const decide = useCallback(
    async (olderId: string, linked: boolean) => {
      const fileId = file.id
      setBusy(true)
      try {
        const answer = await requestFassungLink(fileId, olderId, linked)
        // The link changes both cards: the newer one's „ersetzt …" and the
        // older one's „ersetzt durch …".
        onFassungChanged?.(fileId, answer.newer)
        onFassungChanged?.(olderId, answer.older)
        if (currentId.current === fileId) setFacts(answer.newer)
      } catch {
        if (currentId.current === fileId) toast.error(t('preview.fassung.saveError'))
      } finally {
        setBusy(false)
      }
    },
    [file.id, onFassungChanged, t],
  )

  const compareText = useCallback(
    async (rowKey: string, from: DocumentVersionView, to: DocumentVersionView, numbers: { from: number; to: number }) => {
      const fileId = file.id
      setTextComparison({ rowKey, status: 'loading' })
      try {
        const data = await client.diff(fileId, from.id, to.id)
        if (currentId.current === fileId) {
          setTextComparison({
            rowKey,
            status: 'done',
            from: { number: numbers.from, content: data.from.content },
            to: { number: numbers.to, content: data.to.content },
          })
        }
      } catch {
        // One failed comparison is a line under its row, never a thrown render:
        // the timeline itself is still the useful half of this section.
        if (currentId.current === fileId) setTextComparison({ rowKey, status: 'failed' })
      }
    },
    [client, file.id],
  )

  if (!showsFassungenSection({ facts, versionCount: file.versionCount, hasViewer: viewer !== undefined })) return null
  if (viewer !== undefined && loading && listing === null) {
    return <Skeleton className={cn('h-16 w-full rounded-lg', className)} />
  }

  const newestRead = documentReadFamily(file.status)
  const rows = buildFassungTimeline({
    versions,
    publishedVersionId: listing?.publishedVersionId ?? null,
    history,
    directIds,
    headAt: file.createdAt ?? null,
    newer: supersededBy,
    newestRead,
    predecessorStandsIn: file.authoredBy !== 'agent',
  })
  rowsRef.current = rows
  const standing = fassungStanding({
    rows,
    newest,
    lifecycle,
    reviewerUserIds: listing?.reviewerUserIds ?? [],
    viewer,
    newestRead,
  })

  // Every source of a name the pane has: the listing's own resolution of the
  // people who acted, the assignees, and the reviewer candidates.
  const listedNames = new Map((listing?.people ?? []).map((person) => [person.userId, person.name]))
  const assigneeNames = new Map(Object.entries(names ?? {}))
  const candidateNames = new Map(reviewers.map((person) => [person.userId, person.name]))
  const person = (userId: string | null) =>
    resolvePerson(userId, viewer?.userId, listedNames, assigneeNames, candidateNames)

  /** „Hochgeladen von Anna Berger · 14.08.2026": the person and the date, once. */
  const actLine = (act: VersionAct): string => {
    // A person uploads; Piloti, or a colleague asking for a draft, creates.
    const key = act.key === 'uploaded' && file.authoredBy === 'agent' ? 'created' : act.key
    const who = person(act.actor)
    const name =
      who.kind === 'you' ? t('preview.fassung.rail.byYou') : who.kind === 'name' ? who.name : t('preview.fassung.rail.bySomeone')
    // The person and the date break as one: „Eingereicht von / Anna Berger · 03.09.2026",
    // never a dangling „·" at a line end or a surname alone on the next line.
    return t('preview.fassung.rail.act', {
      act: t(`lifecycle.versions.${key}`),
      name: keepTogether(`${name} · ${formatDate(act.when, locale)}`),
    })
  }
  const uploadedOn = (when: string | null): string[] =>
    when
      ? [t('preview.fassung.rail.actAnonymous', { act: t('lifecycle.versions.uploaded'), date: formatDate(when, locale) })]
      : []

  const tagText = (tag: FassungTag | null): string | null =>
    tag === null ? null : tag.kind === 'index' ? tag.text : t('preview.fassung.rail.dateTag', { date: tag.text })
  const numberLabel = (number: number) => t('preview.fassung.rail.number', { number })
  const ownTag = tagText(fassungTag(file.filename, file.revisionFacts))

  const changeCaption = changeCaptionFor(changeSummary, rows, t)
  const firstChangeKey = rows.find((row) => rowChange(row, changeSummary) !== null)?.key ?? null

  // A lone row that says nothing the header does not is not a timeline.
  const showTimeline = rows.length > 1 || rows.some((row) => rowHasContent(row, changeSummary !== null))
  const offersApprove =
    viewer !== undefined && listing !== null && availableLifecycleGestures(newest, lifecycle, viewer).includes('approve')

  const textComparisonRow = (row: TimelineRow) =>
    textComparison?.rowKey === row.key ? <TextComparisonView comparison={textComparison} /> : null

  const renderVersionRow = (row: VersionRow, index: number): JSX.Element => {
    const { version } = row
    const everArrived = version.state === 'published' || version.state === 'superseded'
    // An earlier upload whose bytes no passing verdict judged (its own,
    // migration 0131, or the item's) is its uploader's and the reviewers' to
    // open (ADR-0086): the routes refuse it to everyone else, so nothing here
    // offers what would be a 404. A screened earlier upload opens for all.
    const openable = version.bytesReadable !== false
    // The newest carries its whole story; an older row, only its last act.
    const acts = row.newest && versionActs(version).length > 0 ? versionActs(version) : [latestAct(version)]
    const predecessorNumber = row.predecessor ? numberOfVersion(rows, row.predecessor.id) : null
    const menu: ActionMenuEntry[] = []
    if (!row.current && everArrived && openable) {
      menu.push({
        type: 'item',
        id: 'download',
        label: t('preview.fassung.versions.download'),
        href: versionFileUrl(file.id, version.id, { download: true }),
        download: true,
        testId: 'fassung-version-download',
      })
    }
    if (row.predecessor && predecessorNumber !== null && openable && row.predecessor.bytesReadable !== false) {
      const predecessor = row.predecessor
      menu.push({
        type: 'item',
        id: 'compare-text',
        label: t('preview.fassung.versions.compareText', { number: predecessorNumber }),
        disabled: textComparison?.rowKey === row.key && textComparison.status === 'loading',
        onSelect: () => void compareText(row.key, predecessor, version, { from: predecessorNumber, to: row.number }),
        testId: 'document-version-compare',
      })
    }
    const change = rowChange(row, changeSummary)
    return (
      <FassungTimelineRow
        key={row.key}
        label={numberLabel(row.number)}
        tag={row.newest ? ownTag : null}
        marker={row.current ? t('preview.fassung.current') : null}
        badge={
          !row.newest && NOTABLE_ROW_STATES.has(version.state) ? (
            <DocumentVersionStateBadge versionState={version.state} always className="bg-background" />
          ) : null
        }
        newest={index === 0}
        acts={acts.map(actLine)}
        comment={version.reviewComment}
        changeCaption={change ? changeCaption : null}
        change={change}
        changeHint={row.key === firstChangeKey ? t('preview.fassung.changeHint') : null}
        changeTestId="fassung-change"
        last={index === rows.length - 1}
        dataset={{ kind: 'version', version: String(version.versionNumber), state: version.state, number: String(row.number) }}
        action={
          // The current Fassung is the document in front of the reader.
          row.current || !openable ? null : (
            <RowAction asChild>
              <a
                href={everArrived ? versionFileUrl(file.id, version.id) : versionContentUrl(file.id, version.id)}
                target="_blank"
                rel="noreferrer"
                data-testid="fassung-version-open"
              >
                {t('preview.fassung.versions.open')}
              </a>
            </RowAction>
          )
        }
        menu={menu}
        menuLabel={t('preview.fassung.rail.rowMenu', { number: row.number })}
      >
        {textComparisonRow(row)}
      </FassungTimelineRow>
    )
  }

  const renderHeadRow = (row: HeadRow, index: number): JSX.Element => (
    <FassungTimelineRow
      key={row.key}
      label={numberLabel(row.number)}
      tag={ownTag}
      marker={row.current ? t('preview.fassung.current') : null}
      newest={index === 0}
      acts={uploadedOn(row.at)}
      changeCaption={changeSummary ? changeCaption : null}
      change={changeSummary?.text ?? null}
      changeHint={row.key === firstChangeKey ? t('preview.fassung.changeHint') : null}
      changeTestId="fassung-change"
      last={index === rows.length - 1}
      dataset={{ kind: 'head', number: String(row.number) }}
    />
  )

  const compareEntry = (older: { id: string; filename: string }, newer: { id: string; filename: string }): ActionMenuEntry => ({
    type: 'item',
    id: 'compare',
    label: t('preview.fassung.compare'),
    onSelect: () => openFassungCompare(older, newer),
    testId: 'fassung-compare',
  })

  const openAction = (documentId: string) =>
    onOpenDocument ? (
      <RowAction onClick={() => onOpenDocument(documentId)} data-testid="fassung-open">
        {t('preview.fassung.open')}
      </RowAction>
    ) : null

  // The Fassung before this one, compared in ONE tap from its row: the on-site
  // question is „what changed since the last one", and the ⋯ menu made it
  // three taps and a guess at where the comparison lives.
  const previousKey = rows.find((candidate) => candidate.kind === 'linked')?.key ?? null

  const renderLinkedRow = (row: LinkedRow, index: number): JSX.Element => {
    const { entry } = row
    const menu: ActionMenuEntry[] = [compareEntry({ id: entry.id, filename: entry.filename }, { id: file.id, filename: file.filename })]
    if (canManage && row.direct) {
      menu.push({
        type: 'item',
        id: 'unlink',
        label: t('preview.fassung.unlink'),
        disabled: busy,
        onSelect: () => void decide(entry.id, false),
        testId: 'fassung-unlink',
      })
    }
    return (
      <FassungTimelineRow
        key={row.key}
        label={numberLabel(row.number)}
        tag={tagText(fassungTag(entry.filename))}
        newest={index === 0}
        filename={entry.filename}
        filenameTail={distinguishingTailLength(entry.filename, file.filename)}
        acts={uploadedOn(entry.createdAt)}
        change={entry.changeSummary}
        changeHint={row.key === firstChangeKey ? t('preview.fassung.changeHint') : null}
        last={index === rows.length - 1}
        dataset={{ kind: 'linked', id: entry.id, number: String(row.number) }}
        action={
          row.key === previousKey ? (
            <>
              <RowAction
                onClick={() => openFassungCompare({ id: entry.id, filename: entry.filename }, { id: file.id, filename: file.filename })}
                data-testid="fassung-compare-previous"
              >
                {t('preview.fassung.compare')}
              </RowAction>
              {openAction(entry.id)}
            </>
          ) : (
            openAction(entry.id)
          )
        }
        menu={menu}
        menuLabel={t('preview.fassung.rail.rowMenu', { number: row.number })}
      >
        {textComparisonRow(row)}
      </FassungTimelineRow>
    )
  }

  const renderNewerRow = (row: NewerRow, index: number): JSX.Element => (
    <FassungTimelineRow
      key={row.key}
      label={numberLabel(row.number)}
      tag={tagText(fassungTag(row.ref.filename))}
      marker={t('preview.fassung.current')}
      newest={index === 0}
      filename={row.ref.filename}
      filenameTail={distinguishingTailLength(row.ref.filename, file.filename)}
      last={index === rows.length - 1}
      dataset={{ kind: 'newer', id: row.ref.id, number: String(row.number) }}
      action={openAction(row.ref.id)}
      menu={[compareEntry({ id: file.id, filename: file.filename }, { id: row.ref.id, filename: row.ref.filename })]}
      menuLabel={t('preview.fassung.rail.rowMenu', { number: row.number })}
    >
      {textComparisonRow(row)}
    </FassungTimelineRow>
  )

  const renderRow = (row: TimelineRow, index: number): JSX.Element => {
    if (row.kind === 'version') return renderVersionRow(row, index)
    if (row.kind === 'head') return renderHeadRow(row, index)
    if (row.kind === 'newer') return renderNewerRow(row, index)
    return renderLinkedRow(row, index)
  }

  // Shown in the header only when there is no timeline to carry it: a lone
  // Fassung's who-and-when, said once.
  const headerAct = !showTimeline && newest ? actLine(latestAct(newest)) : null

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('flex flex-col gap-2', className)}
      data-testid="document-fassungen"
      data-attention={attention || undefined}
      asChild
    >
      <section aria-label={t('lifecycle.title')}>
        {/* The heading IS the trigger: a disclosure whose label is not the thing
            you press has a second target for the same job. */}
        {/* The same header line as every other section of the rail
            (`InspectorSection`): inset to the groups' content edge, uppercase.
            `[text-transform:inherit]` because the preflight resets a button's
            case, which drew this one heading in mixed case under three
            uppercase ones. */}
        <SectionLabel as="h3" className="px-3 font-semibold tracking-[0.05em]">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="touch-target duration-snap hover:text-foreground focus-visible:ring-ring flex min-h-5 w-full items-center gap-1.5 text-left tracking-[inherit] transition-colors ease-out outline-none [text-transform:inherit] focus-visible:ring-2 focus-visible:ring-offset-1 motion-reduce:transition-none"
              data-testid="document-fassungen-toggle"
            >
              <History className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{t('lifecycle.title')}</span>
              <span className="flex-1" />
              <ChevronDown
                aria-hidden
                className={cn(
                  'duration-quick size-3.5 shrink-0 transition-transform ease-out motion-reduce:transition-none',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CollapsibleTrigger>
        </SectionLabel>

        {/* ONE region, divided by what each part asks: where the document
            stands, the decision, Piloti's suggestion, the history, and the
            one-way door. They used to run together as one undivided column
            that widened into a card only while something was asked, so the
            section changed material, and width, under the reader's eye.
            Attention is now the group's stronger edge, and the decision's
            own primary button. */}
        <InspectorGroup
          className={cn(
            '[&>*+*]:border-border/60 [&>*+*]:border-t',
            attention && 'border-foreground/20 shadow-xs',
          )}
        >
        {/* Outside the content, on purpose: this is what the section says when
            it is shut, and it is the reason somebody opens it. */}
        <div className="p-3">
          <FassungHeader standing={standing} person={person} headerAct={headerAct} />
        </div>

        {/* `empty:hidden`: open with nothing to say (no viewer, no suggestion,
            a lone Fassung) it would still take the group's hairline above it
            and draw a second rule along the group's foot. */}
        <CollapsibleContent className="[&>*+*]:border-border/60 [&>*+*]:border-t empty:hidden">
          {viewer !== undefined && listing !== null && newest !== null && (
            <div className="space-y-1.5 p-3">
              <DocumentReviewControls
                version={newest}
                lifecycle={lifecycle}
                viewer={viewer}
                pending={pending}
                onAct={(gesture, options) => void act(gesture, options)}
                reviewers={reviewers}
                fassungNumber={standing.number ?? undefined}
                publishBare
                openMarks={openMarks}
                // The signature line of the approve confirm: the viewer's own
                // name where the surface knows one, else the moment alone.
                actingName={viewer.userId ? (assigneeNames.get(viewer.userId) ?? listedNames.get(viewer.userId) ?? null) : null}
              />
              {offersApprove && (
                <p className="text-muted-foreground text-[11px] leading-snug" data-testid="fassung-approve-explain">
                  {t('preview.fassung.rail.approveExplain')}
                </p>
              )}
            </div>
          )}

          {suggestion && (
            <div className="p-3">
            <SuggestionNotice
              suggestion={suggestion}
              canManage={canManage}
              busy={busy}
              onDecide={(id, linked) => void decide(id, linked)}
            />
            </div>
          )}

          {failed && listing === null && (
            <p className="text-muted-foreground p-3 text-xs" data-testid="document-lifecycle-failed">
              {t('lifecycle.errors.loadFailed')}
            </p>
          )}

          {showTimeline && (
            <ol className="flex flex-col p-3" data-testid="fassung-timeline" aria-label={t('preview.fassung.timeline')}>
              {rows.map(renderRow)}
            </ol>
          )}

          {/* Last, and quiet: the item-level one-way door. One line here; its
              confirm says everything it does before it does it. */}
          {viewer !== undefined && listing !== null && canArchiveDocument(listing.lifecycle, viewer) && (
            <div className="px-3 py-1.5">
            {/* The group's hairline is the divider here, so the action's own
                top rule (`border-t`, for where it stands alone) is taken off. */}
            <DocumentArchiveAction
              compact
              className="border-t-0 pt-0"
              filename={file.filename}
              pending={pending === 'archive'}
              onArchive={() => void act('archive')}
            />
            </div>
          )}
        </CollapsibleContent>
        </InspectorGroup>
        {compareElement}
      </section>
    </Collapsible>
  )
}

/**
 * The header: „Fassung 2 · In Prüfung", the labelled track, the next step with
 * a person, and which Fassung Piloti answers from. Every line is about the
 * newest Fassung; the one exception is the answer sentence, which names the
 * older Fassung by number when that is the one Piloti still uses.
 */
function FassungHeader({
  standing,
  person,
  headerAct,
}: {
  standing: FassungStanding
  person: (userId: string | null) => ReturnType<typeof resolvePerson>
  headerAct: string | null
}): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const stageLabels = STAGE_LABEL_KEYS.map((key) => t(key))
  const { progress, stage } = standing
  return (
    <div className="space-y-1.5" data-testid="fassung-header">
      <p className="text-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-snug">
        {standing.number !== null && (
          <span className="font-medium" data-testid="fassung-header-label">
            {t('preview.fassung.rail.number', { number: standing.number })}
          </span>
        )}
        {standing.state && (
          <DocumentVersionStateBadge
            versionState={standing.state === 'archived' ? null : standing.state}
            lifecycle={standing.state === 'archived' ? 'archived' : 'active'}
            always
            className="bg-background"
            testId="document-lifecycle-state"
          />
        )}
      </p>
      {progress && stage !== null && (
        <div data-testid="document-lifecycle-stand">
          <StageTrack
            stages={LIFECYCLE_STAGES}
            reached={progress.reached}
            halted={progress.halted}
            tone={progress.tone}
            labels={stageLabels}
            current={stage}
            data-testid="document-lifecycle-track"
          />
          <span className="sr-only">
            {t('preview.fassung.rail.stepOf', { step: stage + 1, total: LIFECYCLE_STAGES.length, stage: stageLabels[stage] })}
          </span>
        </div>
      )}
      {standing.nextStep && (
        <p className="text-foreground text-xs leading-snug" data-testid="fassung-next-step" data-step={standing.nextStep.kind}>
          {nextStepText(standing.nextStep, person, t, locale)}
        </p>
      )}
      <p className="text-muted-foreground text-xs leading-snug" data-testid="fassung-answer" data-answer={standing.answer.kind}>
        {answerText(standing, t)}
      </p>
      {headerAct && (
        <p className="text-muted-foreground text-xs leading-snug" data-testid="fassung-header-act">
          {headerAct}
        </p>
      )}
    </div>
  )
}

const NEXT_STEP_KEYS: Record<NextStep['kind'], { who: string; you: string }> = {
  approve: { who: 'next.approve', you: 'next.approveYou' },
  revise: { who: 'next.revise', you: 'next.reviseYou' },
  submit: { who: 'next.submit', you: 'next.submitYou' },
  publish: { who: 'next.publish', you: 'next.publishYou' },
}

/** „Nächster Schritt: Freigabe durch Sabine Gruber", „… Ihre Freigabe", or „… Freigabe" when nobody in particular. */
function nextStepText(
  step: NextStep,
  person: (userId: string | null) => ReturnType<typeof resolvePerson>,
  t: Translator,
  locale: string,
): string {
  const keys = NEXT_STEP_KEYS[step.kind]
  const rail = (key: string, params?: Record<string, string | number>) => t(`preview.fassung.rail.${key}`, params)
  if (step.you) return rail(keys.you)
  // Publishing waits for whoever may publish; nobody in particular is asked.
  if (step.kind === 'publish') return rail(keys.who)
  // A round that names nobody the reader can see is still a Freigabe.
  if (step.people.length === 0) return step.kind === 'approve' ? rail('next.approveOpen') : rail(keys.who, { who: rail('someone') })
  const named = [
    ...new Set(
      step.people.map((userId) => {
        const who = person(userId)
        return keepTogether(who.kind === 'name' ? who.name : rail('someone'))
      }),
    ),
  ]
  const who =
    named.length > 2
      ? rail('whoMore', { names: named[0] ?? '', count: named.length - 1 })
      : new Intl.ListFormat(locale, { type: 'disjunction' }).format(named)
  return rail(keys.who, { who })
}

function answerText(standing: FassungStanding, t: Translator): string {
  const { answer } = standing
  switch (answer.kind) {
    case 'older':
    case 'newer':
      return t(`preview.fassung.rail.answer.${answer.kind}`, { number: answer.number })
    case 'retired':
      return t('lifecycle.meaning.archived')
    default:
      return t(`preview.fassung.rail.answer.${answer.kind}`)
  }
}

/** Non-breaking spaces: a name (and its date) wraps as one piece in a 248px rail. */
function keepTogether(text: string): string {
  return text.replace(/ /g, '\u00a0')
}

/** The change summary a row carries: the document's own on the row that stands for it, a linked document's own on its row. */
function rowChange(row: TimelineRow, summary: FassungFacts['changeSummary']): string | null {
  if (row.kind === 'linked') return row.entry.changeSummary
  if (row.kind === 'head' || (row.kind === 'version' && row.newest)) return summary?.text ?? null
  return null
}

/** „Geändert gegenüber Fassung 2:", by number where the Fassung it is measured against is in the timeline. */
function changeCaptionFor(summary: FassungFacts['changeSummary'], rows: readonly TimelineRow[], t: Translator): string | null {
  if (summary === null) return null
  const basis = summary.basis
  const against =
    basis === 'previous'
      ? rows.find((row) => row.kind === 'linked' && row.direct)
      : rows.find((row) => row.kind === 'linked' && row.entry.id === basis.id)
  if (against) return t('preview.fassung.rail.changedSince', { number: against.number })
  return basis === 'previous'
    ? t('preview.fassung.changedSincePrevious')
    : t('preview.fassung.changedSince', { name: basis.filename })
}

/** Whether a lone row has something to say that the header does not already say. */
function rowHasContent(row: TimelineRow, hasChange: boolean): boolean {
  if (row.kind === 'version') {
    return isPendingVersion(row.version) || Boolean(row.version.reviewComment) || (row.newest && hasChange)
  }
  if (row.kind === 'head') return hasChange
  return true
}

/** The line comparison of two Fassungen, under the row it was asked from, numbered as the timeline numbers them. */
function TextComparisonView({ comparison }: { comparison: TextComparison }): JSX.Element {
  const t = useTranslations('files')
  if (comparison.status === 'loading') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Spinner className="size-3.5" />
        {t('lifecycle.versions.comparing')}
      </p>
    )
  }
  if (comparison.status === 'failed') {
    return (
      <p className="text-destructive text-xs" data-testid="document-version-compare-failed">
        {t('lifecycle.versions.compareFailed')}
      </p>
    )
  }
  return (
    <div data-testid="document-version-comparison">
      <DocumentVersionDiff
        from={{ versionNumber: comparison.from.number, content: comparison.from.content }}
        to={{ versionNumber: comparison.to.number, content: comparison.to.content }}
      />
    </div>
  )
}
