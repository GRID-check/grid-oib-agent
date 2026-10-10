'use client'

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'

/** Mirrors the backend's `MAX_TOPICS`, `MAX_TOPIC_CHARS`, `MAX_TOPIC_WORDS` (document_classification.py). */
export const MAX_TOPICS = 6
const MAX_TOPIC_CHARS = 40
const MAX_TOPIC_WORDS = 3

/** A typed topic as the backend will store it, or null when it is not a usable term. */
export function normalizeTopicInput(raw: string): string | null {
  const term = raw.replace(/ /g, ' ').split(/\s+/).filter(Boolean).join(' ').replace(/^[ .,;:\-–—"'„“]+|[ .,;:\-–—"'„“]+$/g, '')
  if (!term || term.length > MAX_TOPIC_CHARS || term.split(' ').length > MAX_TOPIC_WORDS) return null
  return /\p{L}/u.test(term) ? term : null
}

/**
 * The topics of one document, editable: Piloti's own keywords („Attika",
 * „Holzrahmenbau"), which unlike the tags come from no fixed list — so the
 * input is free text, bounded like the backend bounds it.
 *
 * Saving sends the document's tags too, because a person's correction is kept
 * as theirs for both together (`tags_set_by = 'person'`): once someone has
 * curated a file's labels, a re-read touches neither.
 */
export function DocumentTopicsEditor({
  fileId,
  tags,
  initialTopics,
  onSaved,
}: {
  fileId: string
  /** The document's current tags, sent unchanged beside the topics. */
  tags: readonly string[]
  initialTopics: readonly string[]
  onSaved?: (fileId: string, topics: string[]) => void
}): JSX.Element {
  const t = useTranslations('files')
  const [topics, setTopics] = useState<string[]>([...initialTopics])
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTopics([...initialTopics])
    setInput('')
    // The pane is reused across files; the file id is what resets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  const persist = useCallback(
    async (next: string[], previous: string[]) => {
      setTopics(next)
      setSaving(true)
      try {
        const res = await fetch(`/api/documents/${fileId}/tags`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags, topics: next }),
        })
        if (!res.ok) throw new Error(`Topic update failed (${res.status})`)
        onSaved?.(fileId, next)
      } catch {
        setTopics(previous)
        toast.error(t('preview.reading.topicsSaveError'))
      } finally {
        setSaving(false)
      }
    },
    [fileId, tags, onSaved, t]
  )

  const add = () => {
    const term = normalizeTopicInput(input)
    if (!term) return
    setInput('')
    if (topics.length >= MAX_TOPICS || topics.some((topic) => topic.toLowerCase() === term.toLowerCase())) return
    void persist([...topics, term], topics)
  }

  return (
    <div className="space-y-1.5" data-testid="document-topics-editor">
      <p className="text-muted-foreground text-xs">{t('preview.reading.topics')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {topics.map((topic) => (
          <span
            key={topic}
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
          >
            {topic}
            <button
              type="button"
              onClick={() => void persist(topics.filter((existing) => existing !== topic), topics)}
              disabled={saving}
              aria-label={t('preview.removeTag', { tag: topic })}
              className="hover:bg-accent hover:text-foreground focus-visible:ring-ring touch-target -mr-0.5 rounded-sm p-0.5 transition-colors duration-snap ease-out focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 motion-reduce:transition-none"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        {topics.length < MAX_TOPICS && (
          <span className="relative inline-flex items-center">
            <Plus className="text-muted-foreground pointer-coarse:left-3 pointer-events-none absolute left-1.5 size-3" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              value={input}
              maxLength={MAX_TOPIC_CHARS}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  add()
                }
                if (event.key === 'Escape') {
                  setInput('')
                  inputRef.current?.blur()
                }
              }}
              onBlur={add}
              disabled={saving}
              placeholder={t('preview.reading.addTopic')}
              aria-label={t('preview.reading.addTopic')}
              // 16px on a coarse pointer, or iOS zooms the pane in on focus and never zooms back.
              className="border-input text-foreground placeholder:text-muted-foreground/70 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-40 pointer-coarse:pl-8 pointer-coarse:text-base h-6 w-32 rounded-md border border-dashed bg-transparent pl-6 pr-1.5 text-xs focus-visible:border-solid focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
            />
          </span>
        )}
      </div>
    </div>
  )
}
