'use client'

/**
 * A filename in the answer, as something you can open.
 *
 * „Beginnen Sie mit pd8280-2.pdf, danach der Brandschutzvorprüfung und
 * anschließend den Grundrissen." That sentence names three documents the reader
 * owns, and every one of them used to be dead text — the way to act on it was
 * Dateien, the search box, the name typed back in from memory, and a scroll
 * back to the answer to find out what the next one was called.
 *
 * ## Why this is not a citation
 *
 * A `[3]` and a filename look like the same affordance and are not. A citation
 * carries a claim: a page, a passage, and the assertion that this passage backs
 * that sentence — so the reader's first question is „was ist das?" and the peek
 * answers it, with opening the document a second, optional step. A file
 * reference carries no claim at all. It is the model saying WHICH DOCUMENT,
 * usually about one it did not cite: a plan it recommends reading next, a
 * Bestandsunterlage it says is missing. The reader's first question is „zeig
 * her", so the click OPENS, and the hover peek is the second-order answer
 * rather than the first.
 *
 * ## Where it opens
 *
 * In the preview pane beside the conversation, never over it. That pane already
 * exists and is already how a citation, a filed report and a document card put
 * a document on screen (`openFilePeek`), so this adds no viewer, no second
 * document shape and no second URL — and the reader keeps the answer they were
 * reading, which is the whole point of naming the file in it.
 *
 * On a narrow screen there is no room for two panes and `FilePreviewHost`
 * refuses to peek, so the same document opens as the overlay it can render. A
 * control that silently does nothing on half the devices is the failure mode
 * this product has already written down once.
 *
 * ## Never a dead control
 *
 * Only a name that resolved to a real row is a chip; anything else renders as
 * the plain text the answer wrote. That is enforced upstream — the marker
 * plugin is handed the resolvable names and links nothing else — and again
 * here, because the index can change under a rendered answer (a document
 * deleted in another tab) and a chip that opens nothing is worse than no chip.
 */

import { createContext, useCallback, useContext, type FC, type ReactNode } from 'react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { motion, springPress } from '@/components/motion'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLayoutStore } from '@/features/layout/store'
import { openFilePeek } from '@/features/documents/lib/open-file-peek'
import { fileTypeIcon } from '@/features/documents/components/document-status'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { StoredFile } from '@/features/documents/hooks/use-surfaced-documents'
import { fileNameFromHref } from '../lib/file-references'
import { useChatStore } from '../store'
import { FileReferencePeek } from './FileReferencePeek'

/**
 * Who can resolve a filename in this answer.
 *
 * Same inversion the citation scope makes: the answer built the index once, and
 * every chip in its prose reads that one object rather than doing a lookup of
 * its own that could disagree. With no provider a `#file-ref-…` href is not
 * ours, and the caller's fallback renders — which is the correct behaviour for
 * every markdown surface that is not a chat answer.
 */
export type FileReferenceResolver = (fileName: string) => StoredFile | null

const FileReferenceContext = createContext<FileReferenceResolver | null>(null)

export const FileReferenceProvider: FC<{
  resolve: FileReferenceResolver
  children: ReactNode
}> = ({ resolve, children }) => (
  <FileReferenceContext.Provider value={resolve}>{children}</FileReferenceContext.Provider>
)

export const useFileReferenceResolver = (): FileReferenceResolver | null =>
  useContext(FileReferenceContext)

/**
 * An in-page anchor the answer recognises as one of its file references.
 *
 * Anything else — a citation anchor, a heading link the model wrote — falls
 * through to `fallback`, so this never swallows a link it does not understand.
 */
export const FileReferenceLink: FC<{
  href: string
  children: ReactNode
  fallback: ReactNode
}> = ({ href, children, fallback }) => {
  const resolve = useFileReferenceResolver()
  const fileName = fileNameFromHref(href)
  const resolved = resolve && fileName ? resolve(fileName) : null
  if (!resolved) return <>{fallback}</>
  return (
    <FileReferenceChip stored={resolved} label={children} fileName={fileName ?? resolved.file.filename} />
  )
}

/** Open a stored file beside the conversation — or over it, where there is no beside. */
export const useOpenStoredFile = (): ((stored: StoredFile) => void) => {
  const projectId = useChatStore((state) => state.projectId)
  const isMobile = useIsMobile()

  return useCallback(
    (stored: StoredFile) => {
      // The research panel occupies the same side of the split and the host
      // refuses to peek while it is open. The reader asked for the document, so
      // the panel narrating a run they have already watched steps aside.
      const layout = useLayoutStore.getState()
      if (layout.rightPanel === 'research') layout.closeRightPanel()

      openFilePeek({
        file: stored.file,
        source: stored.corpus === 'buero' ? 'buero' : stored.corpus === 'session' ? 'session' : 'projekt',
        projectId,
        presentation: isMobile ? 'modal' : 'peek',
        // Reading is not redirecting. The reader clicked a name in a sentence to
        // LOOK at the document; committing their next question to it is a
        // decision they have not made, and the pane carries its own „Fragen"
        // for the moment they do.
        bindComposerSubject: false,
      })
    },
    [projectId, isMobile]
  )
}

const FileReferenceChip: FC<{
  stored: StoredFile
  fileName: string
  label: ReactNode
}> = ({ stored, fileName, label }) => {
  const t = useTranslations('chat')
  const peek = useHoverPopover()
  const openFile = useOpenStoredFile()

  return (
    <Popover open={peek.open} onOpenChange={peek.onOpenChange}>
      <PopoverAnchor asChild>
        {/* A press gives way slightly — the kit's vocabulary for anything the
            reader physically touches. Scale only, no vertical move, so a chip
            cannot nudge the line of prose it sits on. */}
        <motion.button
          type="button"
          data-testid="file-reference"
          data-file-reference={stored.file.filename}
          whileTap={{ scale: 0.97 }}
          transition={springPress}
          {...peek.triggerProps}
          // NOT `peek.triggerProps.onClick`, which PINS the popover. On this
          // chip the click is the verb: a tap on a touch screen (where there is
          // no hover to preview with) has to reach the document in one act, not
          // open a panel that then asks for a second one.
          onClick={() => {
            peek.dismiss()
            openFile(stored)
          }}
          aria-label={t('fileReference.openAria', { name: stored.file.filename })}
          className={cn(
            // `inline`, not `inline-flex`. A flex box is unbreakable, and these
            // names are long: on a phone `Wien-Lacknergasse-Grundrisse-\
            // floorplans.pdf` was pushed onto a line of its own and the full
            // stop that ended the sentence wrapped to the line after it, alone.
            // Inline lets the name flow like the text it is, and
            // `box-decoration-break` keeps the rounded ends on the outside of a
            // name that broke across two lines rather than on all four.
            'inline rounded-md [box-decoration-break:clone]',
            // A `button` is centred by the UA stylesheet, which is invisible
            // until a long name wraps — and then the second line of the
            // filename sat centred in a left-aligned paragraph.
            'text-start',
            // The padding is cancelled by an equal negative margin. A mention
            // pill can afford to push its neighbours 3px apart because a thread
            // holds one or two; an answer's reading order holds nine, and at
            // 3px each the sentence rendered as „…floorplans.pdf ." — a stray
            // space in front of every comma and full stop in the paragraph.
            // Negative margin keeps the hover background full-width while
            // giving the space back to the prose at rest.
            'px-[3px] -mx-[3px] py-px',
            // NOT a filled pill. An answer that names nine documents would be
            // nine highlighter strokes, and the reader would be reading the
            // marks rather than the sentence. At rest the name is the answer's
            // own text under a dotted rule — the web's oldest way of saying
            // "there is more here" — and the surface only lights up under the
            // pointer, where it is answering one name rather than shouting
            // about all of them.
            'underline decoration-dotted decoration-foreground/30 underline-offset-[3px]',
            'hover:decoration-solid hover:decoration-foreground/50 hover:bg-muted',
            'focus-visible:bg-muted',
            // A name is wide enough for a fingertip already; only the vertical
            // axis needs help, and growing sideways would push the sentence's
            // own punctuation off the line.
            'pointer-coarse:py-1',
            'cursor-pointer transition-colors duration-quick ease-out',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
          )}
        >
          <FileGlyph file={stored.file} />
          {label}
        </motion.button>
      </PopoverAnchor>
      {/* Mounted only while open, so a paragraph naming six files costs nothing
          until one of them is looked at. */}
      <PopoverContent align="start" className="w-80 p-3" {...peek.contentProps}>
        <FileReferencePeek stored={stored} writtenAs={fileName} onOpen={() => {
          peek.dismiss()
          openFile(stored)
        }} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The one mark that says "this name is a file you can open".
 *
 * Deliberately not the extension: the label already ends in `.pdf`, so a `PDF`
 * badge in front of it would print the same three letters twice. The icon adds
 * the fact the text cannot carry — that this is a control — and `fileTypeIcon`
 * is the same mapping the file list, the preview toolbar and the composer's
 * attachment rows use, so one document does not get three different glyphs
 * depending on where it is named.
 *
 * `em`-sized and baseline-aligned so it rides the sentence rather than opening
 * its leading.
 */
const FileGlyph: FC<{ file: FileItem }> = ({ file }) => {
  const Icon = fileTypeIcon(file.contentType, file.filename)
  return (
    <Icon
      aria-hidden
      // Baseline-nudged rather than flex-aligned, now that the chip is inline:
      // an icon sitting on the text baseline reads as a dropped glyph.
      className="mr-[0.2em] inline-block size-[0.95em] shrink-0 align-[-0.12em] text-foreground/40"
      strokeWidth={2}
    />
  )
}
