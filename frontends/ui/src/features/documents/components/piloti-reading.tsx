'use client'

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useLocale, useTranslations } from '@/i18n'
import { DISCIPLINE_TAGS, DOCUMENT_TYPE_TAGS } from '@/lib/documents/tag-vocabulary'
import type { FileItem } from '../file-types'
import { DocumentTagsEditor } from './document-tags-editor'
import { DocumentTopicsEditor } from './document-topics-editor'
import type { PhotoCapture } from '@/lib/documents/photo-capture'
import { MapPin } from 'lucide-react'

const TYPE_SET = new Set<string>(DOCUMENT_TYPE_TAGS)
const DISCIPLINE_SET = new Set<string>(DISCIPLINE_TAGS)

/**
 * What Piloti took a citable document to be: how much of it was read, what
 * kinds of content it found, and the document type and disciplines it assigned
 * — as Piloti's statement, with a way to correct it.
 *
 * ## Why this replaced an always-open tag editor
 *
 * The rail used to show the tags as a form: removable chips and a dashed
 * „+ Schlagwort" field on every document. A form is something a person is
 * expected to fill in, and feld72 read it exactly that way — „müssen wir die
 * Schlagworte für jede Datei selbst anlegen?" (Jour fixe, 2026-10-09). They do
 * not: Piloti assigns them on every upload. So the tags are now presented as
 * what they are, Piloti's reading of the file, and the editor opens only when
 * a person asks to correct it. A correction is kept as theirs — a re-read no
 * longer writes the classifier's guess back over it.
 *
 * When Piloti found no type, it says so plainly instead of drawing an empty
 * field, and offers the same correction as „Zuordnen".
 */
export function PilotiReading({
  file,
  canManage,
  onTagsUpdated,
}: {
  file: FileItem
  canManage: boolean
  onTagsUpdated?: (fileId: string, tags: string[], topics?: string[]) => void
}): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [correcting, setCorrecting] = useState(false)
  // The rail is reused across files; a correction in progress belongs to one.
  useEffect(() => setCorrecting(false), [file.id])
  /**
   * The tags this reader just saved, until the caller's `file` carries them.
   * Not every surface that mounts the rail feeds `onTagsUpdated` back into the
   * file it passes, and the chips must not snap back to the old reading the
   * moment „Fertig" closes the editor.
   */
  const [saved, setSaved] = useState<string[] | null>(null)
  const incomingKey = (file.tags ?? []).join('\u0000')
  useEffect(() => setSaved(null), [file.id, incomingKey])

  /** The same for topics, saved beside the tags. */
  const [savedTopics, setSavedTopics] = useState<string[] | null>(null)
  const incomingTopicsKey = (file.topics ?? []).join('\u0000')
  useEffect(() => setSavedTopics(null), [file.id, incomingTopicsKey])

  const tags = saved ?? file.tags ?? []
  const topics = savedTopics ?? file.topics ?? []
  const types = tags.filter((tag) => TYPE_SET.has(tag))
  const disciplines = tags.filter((tag) => DISCIPLINE_SET.has(tag))
  const facts = readingFacts(file, locale, t)

  return (
    <div className="flex flex-col gap-2.5" data-testid="piloti-reading">
      {facts && <p className="text-muted-foreground text-xs">{facts}</p>}
      {file.capture && <CaptureLine capture={file.capture} />}

      {correcting ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed p-2.5" data-testid="piloti-reading-editor">
          <DocumentTagsEditor
            fileId={file.id}
            initialTags={tags}
            onTagsUpdated={(id, next) => {
              setSaved(next)
              onTagsUpdated?.(id, next)
            }}
          />
          <DocumentTopicsEditor
            fileId={file.id}
            tags={tags}
            initialTopics={topics}
            onSaved={(id, next) => {
              setSavedTopics(next)
              onTagsUpdated?.(id, tags, next)
            }}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">{t('preview.reading.correctionKept')}</p>
          <Button type="button" size="sm" variant="outline" className="h-7 self-start" onClick={() => setCorrecting(false)}>
            {t('preview.reading.done')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground text-xs">
            {types.length + disciplines.length + topics.length > 0 ? t('preview.reading.classifiedAs') : t('preview.reading.noType')}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {types.map((tag) => (
              <Chip key={tag} variant="secondary" size="sm" data-testid="piloti-reading-type">
                {tag}
              </Chip>
            ))}
            {disciplines.map((tag) => (
              <Chip key={tag} variant="outline" size="sm">
                {tag}
              </Chip>
            ))}
            {topics.map((topic) => (
              <Chip key={topic} variant="muted" size="sm" data-testid="piloti-reading-topic">
                {topic}
              </Chip>
            ))}
            {canManage && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-auto px-1 py-0 text-xs"
                onClick={() => setCorrecting(true)}
                data-testid="piloti-reading-correct"
              >
                {types.length + disciplines.length + topics.length > 0 ? t('preview.reading.correct') : t('preview.reading.assign')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** „12 Seiten gelesen · Text, Tabellen, Zeichnungen" — or null when the listing says neither. */
function readingFacts(file: FileItem, locale: string, t: ReturnType<typeof useTranslations>): string | null {
  const parts: string[] = []
  if (typeof file.pageCount === 'number' && file.pageCount > 0) {
    parts.push(t('brief.pages', { count: file.pageCount, formatted: file.pageCount.toLocaleString(locale) }))
  }
  // Content kinds only when there is something beyond plain text: a lone
  // "Text" is noise on the text-only documents that dominate a project.
  const kinds = file.contentTypes ?? []
  if (kinds.some((content) => content !== 'text')) {
    parts.push(kinds.map((content) => t(`preview.contentTypeNames.${content}`)).join(', '))
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * When, and with what, a photo was taken — from the camera, not the upload —
 * and a link to where, for the people who may open the file. The position is
 * shown here and nowhere a model reads it (`photo_facts.py`).
 */
function CaptureLine({ capture }: { capture: PhotoCapture }) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const when = capture.capturedAt ? formatCapturedAt(capture.capturedAt, locale) : null
  const located = capture.latitude !== undefined && capture.longitude !== undefined
  if (!when && !capture.camera && !located) return null
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs" data-testid="piloti-reading-capture">
      {when && <span>{t('preview.reading.capturedAt', { when })}</span>}
      {capture.camera && (
        <>
          {when && <span aria-hidden>·</span>}
          <span>{capture.camera}</span>
        </>
      )}
      {located && (
        <>
          {(when || capture.camera) && <span aria-hidden>·</span>}
          <a
            href={`https://www.openstreetmap.org/?mlat=${capture.latitude}&mlon=${capture.longitude}#map=18/${capture.latitude}/${capture.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
          >
            <MapPin className="size-3" aria-hidden />
            {t('preview.reading.location')}
          </a>
        </>
      )}
    </p>
  )
}

/**
 * The camera's local time as it wrote it. EXIF time has no zone unless the
 * camera added an offset, so the clock is shown as read rather than converted
 * through the reader's zone — a photo taken at 10:32 on site says 10:32.
 */
function formatCapturedAt(iso: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!match) return iso
  const [, year, month, day, hour, minute] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  const dayLabel = date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  return `${dayLabel}, ${hour}:${minute}`
}
