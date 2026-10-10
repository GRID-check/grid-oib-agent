'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { DISCIPLINE_TAGS, DOCUMENT_TYPE_TAGS, MAX_TAGS } from '@/lib/documents/tag-vocabulary'

/** Every tag a user may assign, in vocabulary order (Dokumenttyp then Fachbereich). */
const ALL_VOCABULARY_TAGS: readonly string[] = [...DOCUMENT_TYPE_TAGS, ...DISCIPLINE_TAGS]

/**
 * Editable tag block inside the indexed panel. Current tags render as chips
 * with a remove (×) affordance; new tags are added through an inline input —
 * Enter commits, Escape clears, blur commits an exact match — backed by
 * suggestion chips because the vocabulary is controlled (the tags PATCH
 * endpoint rejects out-of-vocabulary values server-side). Every add/remove
 * persists immediately and optimistically via the existing FB-8 tags API,
 * reverting with a toast on failure.
 */
export function DocumentTagsEditor({
  fileId,
  initialTags,
  onTagsUpdated,
  readOnly = false,
}: {
  fileId: string
  initialTags: string[]
  onTagsUpdated?: (fileId: string, tags: string[]) => void
  /** Hide the editing affordances and render the tags as static chips. */
  readOnly?: boolean
}) {
  const t = useTranslations('files')
  const [tags, setTags] = useState<string[]>(initialTags)
  const [input, setInput] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset when a different file is selected (the pane is reused across files).
  useEffect(() => {
    setTags(initialTags)
    setInput('')
    setIsEditing(false)
    // initialTags identity changes per file; fileId gates the reset intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  // Tags indexing produces AFTER the file was opened arrive here too. Keyed on
  // the content, not the array (a poll hands a new one every time), and held
  // back while a save is in flight: that save is the reader's own edit, and
  // the value it is about to confirm must not be replaced by the read it raced.
  const initialKey = initialTags.join('\u0000')
  const savingRef = useRef(false)
  savingRef.current = isSaving
  useEffect(() => {
    if (savingRef.current) return
    setTags(initialTags)
    // initialKey IS initialTags, compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey])

  /** PATCH the full replacement tag list; optimistic with revert on failure. */
  const persist = useCallback(
    async (next: string[], previous: string[]) => {
      setTags(next)
      setIsSaving(true)
      try {
        const res = await fetch(`/api/documents/${fileId}/tags`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: next }),
        })
        if (!res.ok) throw new Error(`Tag update failed (${res.status})`)
        // Propagate so the workspace's file state (and initialTags on reselect)
        // reflects the save — otherwise switching away and back reverts.
        onTagsUpdated?.(fileId, next)
      } catch {
        setTags(previous)
        toast.error(t('preview.tagsSaveError'))
      } finally {
        setIsSaving(false)
      }
    },
    [fileId, onTagsUpdated, t]
  )

  const removeTag = useCallback(
    (tag: string) => {
      void persist(
        tags.filter((existing) => existing !== tag),
        tags
      )
    },
    [persist, tags]
  )

  const addTag = useCallback(
    (tag: string) => {
      if (tags.includes(tag) || tags.length >= MAX_TAGS) return
      setInput('')
      void persist([...tags, tag], tags)
    },
    [persist, tags]
  )

  // Vocabulary entries still assignable, narrowed by the typed query.
  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase()
    const available = ALL_VOCABULARY_TAGS.filter((tag) => !tags.includes(tag))
    return q ? available.filter((tag) => tag.toLowerCase().includes(q)) : available
  }, [input, tags])

  /** Resolve the free-typed input to a canonical vocabulary entry, if any. */
  const resolveInput = useCallback((): string | null => {
    const q = input.trim().toLowerCase()
    if (!q) return null
    const exact = ALL_VOCABULARY_TAGS.find((tag) => tag.toLowerCase() === q)
    if (exact && !tags.includes(exact)) return exact
    // A query narrowing to exactly one candidate is unambiguous — accept it.
    return suggestions.length === 1 ? suggestions[0] : null
  }, [input, suggestions, tags])

  const atCap = tags.length >= MAX_TAGS
  const showNoMatchHint = isEditing && input.trim() !== '' && suggestions.length === 0

  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs">{t('preview.tags')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
          >
            {tag}
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeTag(tag)}
                disabled={isSaving}
                aria-label={t('preview.removeTag', { tag })}
                className="duration-snap hover:bg-accent hover:text-foreground focus-visible:ring-ring touch-target -mr-0.5 rounded-sm p-0.5 transition-colors ease-out focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 motion-reduce:transition-none"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </span>
        ))}
        {tags.length === 0 && readOnly && (
          <span className="text-muted-foreground/70 text-xs">{t('preview.noTags')}</span>
        )}
        {!readOnly && !atCap && (
          <span className="relative inline-flex items-center">
            {/* Follows the field's own left padding, which grows with it. */}
            <Plus
              className="text-muted-foreground pointer-coarse:left-3 pointer-events-none absolute left-1.5 size-3"
              aria-hidden
            />
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setIsEditing(true)}
              onBlur={() => {
                // Blur commits an exact/unambiguous match, otherwise discards.
                const resolved = resolveInput()
                if (resolved) addTag(resolved)
                else setInput('')
                setIsEditing(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const resolved = resolveInput()
                  if (resolved) addTag(resolved)
                }
                if (e.key === 'Escape') {
                  setInput('')
                  setIsEditing(false)
                  inputRef.current?.blur()
                }
              }}
              disabled={isSaving}
              placeholder={t('preview.addTagPlaceholder')}
              aria-label={t('preview.addTagLabel')}
              // A raw `<input>`, so it inherits none of what `ui/input.tsx` does
              // for a phone. Two of those are load-bearing here:
              //
              // `text-xs` is 12px, and iOS Safari zooms the whole page in when a
              // field under 16px takes focus. That zoom is not undone on blur —
              // the reader is left in a magnified preview pane, scrolled
              // sideways, having typed one tag. `pointer-coarse:text-base` is the
              // same 16px floor the Input primitive carries, applied on the axis
              // that actually predicts a soft keyboard.
              //
              // `h-6` is 24px, a little over half the touch floor, on a control
              // that has to be hit precisely because a mis-tap lands on a tag
              // chip that removes itself.
              className="border-input text-foreground placeholder:text-muted-foreground/70 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-36 pointer-coarse:pl-8 pointer-coarse:text-base h-6 w-28 rounded-md border border-dashed bg-transparent pl-6 pr-1.5 text-xs focus-visible:border-solid focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
            />
          </span>
        )}
      </div>
      {/* Controlled-vocabulary suggestions while the input is active: the PATCH
          endpoint rejects free-form values, so offer the real choices. */}
      {!readOnly && isEditing && suggestions.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('preview.suggestionsLabel')}
        >
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              // Keep the input focused so blur doesn't race the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(tag)}
              disabled={isSaving}
              // The suggestions ARE the way to add a tag on a phone: the endpoint
              // rejects free-form values, so tapping one of these is the whole
              // interaction, and at `py-0.5` each was a 20px chip in a wrapped row
              // of them. Grown rather than overhung — they are neighbours in a
              // flex-wrap row, so catchments would land on each other.
              className="border-border text-muted-foreground duration-snap hover:bg-muted hover:text-foreground focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:px-3.5 inline-flex items-center rounded-md border bg-transparent px-2 py-0.5 text-xs font-medium transition-colors ease-out focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 motion-reduce:transition-none"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {showNoMatchHint && (
        <p className="text-muted-foreground/70 text-xs">{t('preview.noTagMatch')}</p>
      )}
    </div>
  )
}
