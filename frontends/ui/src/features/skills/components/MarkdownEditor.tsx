'use client'

/**
 * The Markdown editor used to write a skill's instruction body.
 *
 * A skill body IS Markdown — headings, lists and fenced blocks are how the
 * agentskills.io format carries structure — so the box it is written in should
 * know that. A bare <textarea> does not: it offers no formatting, no way to see
 * the document as the agent will read it, and no room, which is exactly what
 * writing a long instruction needs most.
 *
 * This wraps `@uiw/react-md-editor`, which is a real editor (toolbar, keyboard
 * shortcuts, highlighted source, split preview, fullscreen) around a plain
 * <textarea> — so the control stays a form control: labelled, focusable,
 * blur-able, and readable by tests and assistive tech alike.
 *
 * Two deliberate departures from the library's defaults:
 *  - The preview renders through the app's own `MarkdownRenderer`, so what the
 *    author previews is the component that will actually render the agent's
 *    Markdown elsewhere in GRID — not the library's GitHub-styled copy.
 *  - The toolbar is curated and localised. The library ships twenty-odd
 *    commands with English tooltips; a skill body needs headings, emphasis,
 *    lists, links, quotes, code and tables, and the rest is noise.
 */

import { useMemo, type FC, type ReactElement } from 'react'
import MDEditor, { commands, type ICommand } from '@uiw/react-md-editor'
import '@uiw/react-md-editor/markdown-editor.css'
import './markdown-editor.css'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { cn } from '@/lib/utils'

export interface MarkdownEditorProps {
  /** Set on the underlying <textarea>, so an external <label> can address it. */
  id: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  /** Height of the writing surface in px; the drag handle can grow it. */
  height?: number
  invalid?: boolean
  className?: string
  /**
   * Tooltip/aria text for every toolbar button, in the UI language. Passed in
   * rather than read from `useTranslations` here so this component keeps no
   * opinion about which dictionary namespace owns the strings.
   */
  labels: MarkdownEditorLabels
}

export interface MarkdownEditorLabels {
  h1: string
  h2: string
  h3: string
  bold: string
  italic: string
  code: string
  codeBlock: string
  bulletList: string
  numberedList: string
  taskList: string
  link: string
  quote: string
  table: string
  edit: string
  split: string
  preview: string
  fullscreen: string
}

/** A heading button whose icon is the level itself — clearer than a glyph. */
function headingCommand(base: ICommand, glyph: string, label: string): ICommand {
  return {
    ...base,
    icon: (
      <span className="text-[11px] font-semibold leading-none tracking-tight">{glyph}</span>
    ),
    buttonProps: { 'aria-label': label, title: label },
  }
}

function relabel(base: ICommand, label: string): ICommand {
  return { ...base, buttonProps: { 'aria-label': label, title: label } }
}

export const MarkdownEditor: FC<MarkdownEditorProps> = ({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  height = 360,
  invalid = false,
  className,
  labels,
}) => {
  const toolbar = useMemo<ICommand[]>(
    () => [
      headingCommand(commands.heading1, 'H1', labels.h1),
      headingCommand(commands.heading2, 'H2', labels.h2),
      headingCommand(commands.heading3, 'H3', labels.h3),
      commands.divider,
      relabel(commands.bold, labels.bold),
      relabel(commands.italic, labels.italic),
      relabel(commands.code, labels.code),
      relabel(commands.codeBlock, labels.codeBlock),
      commands.divider,
      relabel(commands.unorderedListCommand, labels.bulletList),
      relabel(commands.orderedListCommand, labels.numberedList),
      relabel(commands.checkedListCommand, labels.taskList),
      commands.divider,
      relabel(commands.link, labels.link),
      relabel(commands.quote, labels.quote),
      relabel(commands.table, labels.table),
    ],
    [labels],
  )

  const viewCommands = useMemo<ICommand[]>(
    () => [
      relabel(commands.codeEdit, labels.edit),
      relabel(commands.codeLive, labels.split),
      relabel(commands.codePreview, labels.preview),
      commands.divider,
      relabel(commands.fullscreen, labels.fullscreen),
    ],
    [labels],
  )

  return (
    <MDEditor
      value={value}
      onChange={(next) => onChange(next ?? '')}
      height={height}
      minHeight={200}
      maxHeight={760}
      preview="edit"
      className={cn('grid-md-editor', className)}
      aria-invalid={invalid || undefined}
      commands={toolbar}
      extraCommands={viewCommands}
      textareaProps={{
        id,
        placeholder,
        onBlur,
        spellCheck: true,
      }}
      components={{
        // The app's renderer, so the preview is the real thing rather than a
        // second Markdown implementation that agrees with it only by accident.
        preview: (source): ReactElement => (
          <MarkdownRenderer content={source} className="text-sm" compact />
        ),
      }}
    />
  )
}
