'use client'

/**
 * The composer's `/` behaviour, in one place.
 *
 * `InputArea` is already the largest component in the app and the repo's
 * working style is explicit that logic belongs in modules rather than in its
 * render function, so everything this feature adds to the composer lives here
 * and in `../lib/slash-command`: the component keeps a picker, a handful of
 * props, and no decisions.
 *
 * ## The text IS the invocation
 *
 * There is deliberately no state, and since forcing a skill onto a turn was
 * removed there is nothing else either: picking from the `/` menu writes
 * `/name ` into the composer and that is the whole effect. Nothing structured
 * leaves with the message — the model reads the name in the text and picks the
 * skill out of the same catalog it always chooses from.
 *
 * So `invokedSkill` is DERIVED from the composer text on every render
 * (`resolveSlashInvocation`), deleting the token removes the reference with no
 * bookkeeping, and no state can drift from what the user can see. `@` mentions
 * cannot do this — two people can share a display name, so a mention must
 * remember which person was picked — but a skill name is unique and exact,
 * which is what lets the text be the complete record.
 */

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  findSlashCommandQuery,
  insertSlashCommand,
  resolveSlashInvocation,
  type SlashCommandQuery,
} from '../lib/slash-command'
import type {
  SlashCommandPickerHandle,
  SlashCommandPickerAria,
  SlashCommandSkill,
} from '../components/SlashCommandPicker'
import { useInvocableSkills } from './use-invocable-skills'

export interface UseSlashCommandOptions {
  /** The composer text, exactly as the textarea holds it. */
  text: string
  /** False ⇒ the composer behaves exactly as it did before this feature. */
  enabled: boolean
  /** Replace the text and place the caret (the composer owns both). */
  onReplaceText: (text: string, caret: number) => void
}

export interface UseSlashCommandResult {
  open: boolean
  query: string
  skills: SlashCommandSkill[]
  loading: boolean
  pickerRef: React.RefObject<SlashCommandPickerHandle>
  aria: SlashCommandPickerAria
  onAriaChange: (aria: SlashCommandPickerAria) => void
  /** Call from the composer's value-change handler. */
  syncQuery: (text: string, caret: number) => void
  /** Insert the picked skill; the composer's select handler. */
  select: (skill: SlashCommandSkill) => void
  /**
   * Handle a key while the picker is open. Returns true when the key was
   * consumed and the composer must do nothing else with it.
   */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, onSubmit: () => void) => boolean
  /** The skill this message currently names, or null. Derived from the text. */
  invokedSkill: SlashCommandSkill | null
  /** Drop the skill's name from the message, keeping everything else typed. */
  clearInvocation: () => void
  /** Close the panel without touching the text (Escape, a click outside). */
  dismiss: () => void
}

export function useSlashCommand({
  text,
  enabled,
  onReplaceText,
}: UseSlashCommandOptions): UseSlashCommandResult {
  const [query, setQuery] = useState<SlashCommandQuery | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [aria, setAria] = useState<SlashCommandPickerAria>({
    listboxId: null,
    activeOptionId: null,
  })
  const pickerRef = useRef<SlashCommandPickerHandle>(null)

  // Nothing is fetched until the user types `/` — or until the text ALREADY
  // leads with a plausible `/token`, which is how a draft that was restored, or
  // a task prompt loaded for editing, gets its chip without the author having
  // to retype the name to be told it is recognised. Shape only; whether the
  // token names a real skill is still decided against the fetched list.
  const namesSomething = /^\s*\/[^\s/]+/.test(text)
  const { skills, loading, available } = useInvocableSkills(enabled && (query !== null || namesSomething))

  const names = useMemo(() => skills.map((skill) => skill.name), [skills])

  const invokedSkill = useMemo(() => {
    if (!enabled) return null
    const invocation = resolveSlashInvocation(text, names)
    if (!invocation) return null
    return skills.find((skill) => skill.name === invocation.skillName) ?? null
  }, [enabled, names, skills, text])

  const syncQuery = useCallback(
    (nextText: string, caret: number) => {
      if (!enabled) return
      const range = findSlashCommandQuery(nextText, caret)
      setQuery(range)
      // A fresh `/` re-opens a panel the user dismissed with Escape; without
      // this, one Escape disabled the feature for the rest of the message.
      if (range === null) setDismissed(false)
    },
    [enabled],
  )

  const select = useCallback(
    (skill: SlashCommandSkill) => {
      if (!query) return
      const { text: nextText, caret } = insertSlashCommand(text, query, skill.name)
      onReplaceText(nextText, caret)
      setQuery(null)
      setDismissed(false)
    },
    [onReplaceText, query, text],
  )

  /*
    The panel opens only once the feature has answered — mirroring the mention
    picker's `(loading || data !== null)` gate, and for the same reason: with the
    feature gated off (or the request lost) typing `/` must behave exactly as it
    did before this existed, rather than flashing an empty panel over the
    composer. A successful empty answer DOES open, because the empty state is
    where the product explains what skills are.
  */
  const open = enabled && query !== null && !dismissed && (loading || available)

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>, onSubmit: () => void): boolean => {
      if (!open) return false

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        pickerRef.current?.move(1)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        pickerRef.current?.move(-1)
        return true
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        if (pickerRef.current?.selectActive()) return true
        // Nothing to insert — what was typed matches no skill. Close, and let an
        // Enter mean what it otherwise means: send. Swallowing it here would
        // strand a user whose message legitimately starts with a slash.
        setDismissed(true)
        if (event.key === 'Enter') onSubmit()
        return true
      }
      if (event.key === 'Escape') {
        // Stop here: an Escape that bubbles would close the surrounding surface.
        event.preventDefault()
        event.stopPropagation()
        setDismissed(true)
        return true
      }
      return false
    },
    [open],
  )

  const dismiss = useCallback(() => setDismissed(true), [])

  const clearInvocation = useCallback(() => {
    const invocation = resolveSlashInvocation(text, names)
    if (!invocation) return
    // Remove the token and the single space after it, keeping the request the
    // user typed alongside it — dropping the skill must not cost them their
    // sentence.
    const start = text.search(/\S/)
    const rest = text.slice(start + 1 + invocation.skillName.length).replace(/^[ \t]/, '')
    const next = `${text.slice(0, start)}${rest}`
    onReplaceText(next, start)
  }, [names, onReplaceText, text])

  return {
    open,
    query: query?.query ?? '',
    skills,
    loading,
    pickerRef,
    aria,
    onAriaChange: setAria,
    syncQuery,
    select,
    handleKeyDown,
    invokedSkill,
    clearInvocation,
    dismiss,
  }
}
