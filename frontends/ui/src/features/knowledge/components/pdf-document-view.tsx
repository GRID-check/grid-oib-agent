'use client'

/**
 * The in-app PDF viewer, and the reason a citation can point at a SENTENCE.
 *
 * This replaced a plain `<iframe>` on the browser's built-in viewer. That frame
 * was opaque by construction — the app could hand it `#page=12` and nothing
 * else: it could not read where the reader was, could not scroll it, and above
 * all could not draw on it. So a citation that knew exactly which passage the
 * answer leaned on could only ever say "page 12", and the reader arrived at a
 * wall of text with the actual work — find the sentence — still to do.
 *
 * Rendering the page ourselves is what buys the text layer, and the text layer
 * is what turns the snippet the citation already carries into coordinates (see
 * `passage-highlight.ts` for the matching, `pdf-text-chunks.ts` for the
 * geometry). The same text layer is what the reader's own search runs over.
 *
 * It is the ONE viewer: the citation dialog, the Files preview, its enlarged
 * view, the chat peek and the knowledge pages all open a PDF here, so a PDF
 * looks and handles the same wherever it is opened. One material — the pages
 * are raised white sheets on a recessed stage, white in both themes because
 * paper is — and one set of controls in a glass pill floating at the foot of
 * the stage: pages, the way back to a passage, zoom, search. A wide stage adds
 * a page rail down its left edge.
 *
 * Pages rasterise only while near the viewport and drop their bitmap when they
 * leave, because a 200-page Einreichplan held at device resolution is gigabytes
 * of canvas — the naive version does not survive the documents this product is
 * for.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type JSX,
  type ReactNode,
} from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { AlertTriangle, Check, ExternalLink, LockKeyhole, Quote, RotateCcw, TextSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { FloatingNote } from '@/components/ui/floating-toolbar'
import { InsetStage } from '@/components/ui/inset-stage'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { REPLAY_BLOCK_CLASS } from '@/lib/analytics/posthog-config'
import { capturePosthog } from '@/lib/analytics/posthog'
import { useTranslations } from '@/i18n'
import { SIMILAR_PASSAGE_TEXT_MIN } from '@/lib/similar-passages/types'
import {
  documentParameters,
  loadPdfjs,
  readPageTextItems,
  renderTextLayer,
  type TextLayerHandle,
} from '../lib/pdfjs-runtime'
import { pageTextChunks } from '../lib/pdf-text-chunks'
import type { PageRegion } from '../lib/page-region'
import { RegionMarks } from './region-marks'
import {
  buildPassageIndex,
  findOccurrences,
  locatePassage,
  MIN_SEARCH_QUERY,
  normalizePassage,
  passageBounds,
  type HighlightRect,
  type PassageIndex,
} from '../lib/passage-highlight'
import {
  clampPage,
  clampZoom,
  fitWidth,
  stepZoom,
  viewerKeyAction,
  type FitMode,
} from '../lib/pdf-zoom'
import { useZoomGestures } from '../lib/use-zoom-gestures'
import { PageSheet } from './pdf-viewer-atoms'
import { PdfThumbnailRail } from './pdf-thumbnail-rail'
import { PdfControls, PdfSearchBar } from './pdf-viewer-toolbar'

export interface PdfDocumentViewProps {
  /** URL the document streams from (corpus route or presigned object store). */
  src: string
  title: string
  /** 1-based page to open at. */
  page?: number | null
  /** Cited passage to find on `page` and light up. */
  highlight?: string | null
  /**
   * CSS colour for the mark, so it matches the chip that opened the viewer.
   * A plain colour rather than a source-tint enum keeps this component free of
   * the chat feature's vocabulary.
   */
  highlightColor?: string
  /**
   * Boxes on `page` to mark, for a passage read off a picture of the page — a
   * plan's depiction — rather than out of its text (issue #433). Drawn in the
   * same tint as a passage mark. The caller passes these OR a `highlight`: a
   * region's passage is the model's description of the drawing, and searching
   * the page's text for it would only search the neighbours next.
   */
  regions?: readonly PageRegion[] | null
  /**
   * Turn a passage the READER selected into the text they want on their
   * clipboard — a quotation with the document and page attached, the form a
   * Stellungnahme quotes in.
   *
   * A formatter rather than a component: the citation vocabulary belongs to
   * whoever opened this viewer (the chat knows the document's title, its
   * Richtlinie, its edition), and the viewer knows only which page the words
   * were on. Left unset the affordance is not offered at all, which is the
   * right answer for a plain file preview — the browser's own copy is enough
   * for someone who is not citing anything.
   */
  quoteFormat?: (quote: { text: string; page: number }) => string
  /**
   * Look for passages like the one the READER selected („Im Büro behandelt"):
   * the selection's words and the page they are on. Left unset, the offer is
   * not made. Like `quoteFormat` a callback, not a component: who may be
   * searched and where the answer is shown belong to whoever opened the viewer.
   */
  onFindSimilar?: (passage: { text: string; page: number }) => void
  /**
   * The document could not be opened (pdf.js failed to load, the stream
   * refused, the bytes are not a PDF). Left unset, the viewer shows its own
   * failure on the stage: what happened, a retry, and the browser's own viewer
   * as the way out. A caller that owns a failure state of its own (the Files
   * preview pane, whose retry asks the preview route again) passes this, and
   * the viewer then renders nothing on failure and leaves the answer to it.
   * A password-protected document is not a failure: the viewer asks for the
   * password either way.
   */
  onLoadError?: () => void
  /**
   * Who draws the ground the pages lie on. `stage` (the default): the viewer
   * brings its own recessed stage. `host`: the caller already lays one (the
   * chat peek's `InsetStage`), and a second one inside it would be a stage on
   * a stage. Everything else — the sheets, the pill, the rail — is the same.
   */
  ground?: 'stage' | 'host'
  /**
   * What the caller lays over one page: marks it keeps itself (a document's
   * Anmerkungen), positioned in PERCENT of the page as `RegionMarks` are, so
   * they need no scale and survive every zoom. A render function rather than a
   * list of pins, for the reason `quoteFormat` is a formatter: what a mark
   * means belongs to whoever opened the viewer, and the viewer knows pages.
   */
  pageOverlay?: (page: number) => ReactNode
  /**
   * Controls the caller adds to the start of the viewer's own pill (a review
   * surface's tools), so a stage has one pill rather than two competing at its
   * foot. Rendered as they come, followed by a divider.
   */
  toolbarLead?: ReactNode
  /**
   * A point to bring to the middle of the view: a page, and the share of its
   * height to centre. A new `key` asks again for the same point. `instant`
   * jumps rather than glides, for a view that follows somebody else's.
   */
  focus?: { page: number; y: number; key: string | number; instant?: boolean } | null
  /**
   * Where the view is, whenever it moves: the page at its middle and the share
   * of that page's height there. For a reader others may follow.
   */
  onViewport?: (viewport: { page: number; y: number }) => void
  className?: string
}

/** A point on a page, as a share of the page as the viewer shows it, top-left origin. */
export interface PagePoint {
  page: number
  x: number
  y: number
}

/** The point a click at (`clientX`, `clientY`) hit on a page whose box is `rect`, clamped onto the page. */
export function pointOnPage(
  page: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  clientX: number,
  clientY: number,
): PagePoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return {
    page,
    x: clamp((clientX - rect.left) / rect.width),
    y: clamp((clientY - rect.top) / rect.height),
  }
}

/**
 * How far either side of the cited page the passage is still looked for.
 *
 * The page number is somebody else's arithmetic: retrieval counts sheets, and
 * a document whose own numbering starts after a cover page — which is most of
 * them — is off by one against it; a title sheet plus a table of contents make
 * it two. That mismatch used to cost the reader the entire feature, silently:
 * the viewer opened at the wrong page with nothing marked, indistinguishable
 * from a passage that could not be found at all.
 *
 * The radius stays at 0 until the cited page itself comes up empty, widens to
 * one page either side then, and to two only once both neighbours have come up
 * empty as well — so the second ring is looked at only after the first has
 * answered, never speculatively. Two is the ceiling: the matchers are strict
 * enough that a neighbour either holds the quoted sentence or holds nothing,
 * so looking next door cannot invent a hit, but three pages out is no longer a
 * numbering offset, it is a different passage that happens to read alike.
 *
 * Derived from the misses rather than stored, so a new Fundstelle resets it
 * with them and no state can disagree with what the pages actually reported.
 */
export const MAX_SEARCH_RADIUS = 2

export function searchRadius(
  page: number | null | undefined,
  missed: readonly number[],
  numPages: number,
): number {
  if (!page || !missed.includes(page)) return 0
  const neighbours = pagesWithin(page, 1, numPages).filter((number) => number !== page)
  return neighbours.every((number) => missed.includes(number)) ? MAX_SEARCH_RADIUS : 1
}

/** The page numbers within `radius` of `page` that the document actually has. */
export function pagesWithin(page: number, radius: number, numPages: number): number[] {
  const pages: number[] = []
  for (let number = page - radius; number <= page + radius; number += 1) {
    if (number >= 1 && number <= numPages) pages.push(number)
  }
  return pages
}

/**
 * The proportion of the loading placeholder: an ISO 216 page (A4, A3, …), the
 * shape almost every Austrian Norm, Richtlinie and Bescheid comes in. Wrong
 * for a landscape plan, which then changes shape once; right for the rest,
 * which do not move at all when the first page lands.
 */
const PLACEHOLDER_PAGE_ASPECT = Math.SQRT2

/** Horizontal room left for the page shadow and the scrollbar. */
const GUTTER = 24

/**
 * How far outside the viewport a page rasterises, and how far past it a page
 * keeps its bitmap. One band for both directions gives the eviction enough
 * hysteresis that an ordinary scroll does not thrash it.
 */
const PRERENDER_MARGIN = '150% 0px'

/** Where a located passage comes to rest in the frame — high, but with lead-in. */
const PASSAGE_SCROLL_OFFSET = 0.28

/** Cap on device-pixel oversampling; past 2× the memory buys nothing visible. */
const MAX_PIXEL_RATIO = 2

/**
 * The band, as a share of the frame, that decides which page the reader is ON.
 * A thin strip across the middle: whatever crosses it is what they are reading,
 * and only one page can be there at a time, so the counter never flickers
 * between two pages the way a "most visible" rule does at a page boundary.
 */
const CURRENT_PAGE_BAND = '-45% 0px -45% 0px'

/** How long a copied-confirmation stays up before the bar goes quiet again. */
const COPIED_FEEDBACK_MS = 1600

/** Shorter than this, a selection is a mis-click rather than a quotation. */
const MIN_QUOTE_LENGTH = 3

interface PassageHit {
  page: number
  rects: HighlightRect[]
  /**
   * The mark is the software's best guess, not the passage verbatim: a
   * windowed or partial match. A reader verifying a citation needs to see the
   * difference, so the mark wears it.
   */
  fuzzy: boolean
}

/** A selection the reader made, and where to hang the offer to quote it. */
interface QuoteSelection {
  text: string
  page: number
  /** Top-left of the selection, in the page stack's own coordinates. */
  x: number
  y: number
}


/** Vertical room the stage keeps around a page fitted whole: the padding above it and the pill below. */
const FIT_PAGE_PADDING = 80

/** How long a zoom waits before re-rasterising, so a pinch re-draws once and not every frame. */
const RERASTER_DELAY_MS = 140

/** How long a typed query waits before the document is searched. */
const SEARCH_DEBOUNCE_MS = 180

/** How long the page has to stay put before it is announced. */
const ANNOUNCE_DELAY_MS = 400

/** One of the reader's own search hits. */
interface SearchHit {
  page: number
  rects: HighlightRect[]
}

/** Where a zoom started, so the point under the pointer stays under it. */
interface ZoomAnchor {
  /** The point in the frame's visible box. */
  x: number
  y: number
  /** The same point in the page stack, before the zoom. */
  contentX: number
  contentY: number
  ratio: number
}

type LoadState = 'loading' | 'ready' | 'failed' | 'locked' | 'wrong-password'

/** pdf.js says "this document needs a password" with a `PasswordException`; code 2 is "that one was wrong". */
const passwordState = (error: unknown): 'locked' | 'wrong-password' | null => {
  if (typeof error !== 'object' || error === null) return null
  const { name, code } = error as { name?: unknown; code?: unknown }
  if (name !== 'PasswordException') return null
  return code === 2 ? 'wrong-password' : 'locked'
}

/** Smooth scrolling is motion, and a reader who asked for less of it gets a jump. */
const scrollBehavior = (smooth: boolean): ScrollBehavior => {
  if (!smooth) return 'auto'
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth'
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

export const PdfDocumentView: FC<PdfDocumentViewProps> = ({
  src,
  title,
  page,
  highlight,
  highlightColor,
  regions,
  quoteFormat,
  onFindSimilar,
  onLoadError,
  ground = 'stage',
  pageOverlay,
  toolbarLead,
  focus,
  onViewport,
  className,
}) => {
  const t = useTranslations('knowledge')
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  // Bumped by "try again", which re-runs the load with everything else equal.
  const [attempt, setAttempt] = useState(0)
  const [password, setPassword] = useState<string | null>(null)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<FitMode>('width')
  const [railOpen, setRailOpen] = useState(true)
  const [hit, setHit] = useState<PassageHit | null>(null)
  // Page 1's shape, used to reserve room for pages that have not rasterised.
  const [defaultAspect, setDefaultAspect] = useState<number | null>(null)
  // Bumped to replay the arrival animation — a CSS animation only runs on
  // mount, so re-pinging means remounting the marks.
  const [ping, setPing] = useState(0)
  // Which page the reader is on, for the counter. Not the same question as
  // which page is rendered: several are, always.
  const [currentPage, setCurrentPage] = useState(1)
  // What the live region says, a beat after the page settles. Announcing every
  // page a fast scroll passes through would be a screen reader reading numbers
  // at the listener for as long as they scroll.
  const [announced, setAnnounced] = useState('')
  // Pages that read their text and did not hold the passage. Once every page
  // that could have held it has said so, the viewer can say so too.
  const [missed, setMissed] = useState<number[]>([])
  // The reader's own selection, in the content's coordinates, plus what to do
  // with it. Null whenever nothing is selected inside the document.
  const [quote, setQuote] = useState<QuoteSelection | null>(null)
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')
  // Find in document. `hits` is null while a search is running.
  const [searchOpen, setSearchOpen] = useState(false)
  // Bumped by Cmd+F while the bar is already open, which focuses it again.
  const [searchFocus, setSearchFocus] = useState(0)
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>([])
  const [activeHit, setActiveHit] = useState(0)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  // The page stack itself. Selection coordinates are measured against THIS, not
  // the frame: it scrolls with the document, so the quote bar stays on the words
  // it belongs to instead of hanging in the frame while the text moves away.
  const contentRef = useRef<HTMLDivElement | null>(null)
  // The text the current offer is for, so a re-measure can tell a new selection
  // from the same one seen again.
  const quotedRef = useRef<string | null>(null)
  // Whether THIS question has already been answered, read synchronously so two
  // pages reporting a hit in the same tick cannot both act on it.
  const foundRef = useRef(false)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  // Each page's unscaled width, so a rectangle in page coordinates can be
  // turned into a scroll offset at whatever size the page is drawn at NOW.
  const pageWidths = useRef(new Map<number, number>())
  // Each page's searchable text, built once per document and kept for the
  // next query: a reader refines a search keystroke by keystroke.
  const pageIndexes = useRef(new Map<number, PassageIndex>())
  // The zoom a gesture is building on. A pinch fires faster than React
  // re-renders, and building each step on the last RENDERED zoom would lose
  // the steps in between.
  const zoomRef = useRef(1)
  const anchorRef = useRef<ZoomAnchor | null>(null)
  const currentPageRef = useRef(1)
  currentPageRef.current = currentPage

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setLoadState('loading')
    const parameters = password ? { ...documentParameters(src), password } : documentParameters(src)
    const task = loadPdfjs().then((pdfjs) => pdfjs.getDocument(parameters))
    task
      .then((loading) => loading.promise)
      .then((loaded) => {
        if (cancelled) return
        setDoc(loaded)
        setLoadState('ready')
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadState(passwordState(error) ?? 'failed')
      })
    return () => {
      cancelled = true
      // Tearing down the LOADING TASK is what releases the document and the
      // worker's copy of it — a document left open holds its page cache, which
      // for a scanned plan set is tens of megabytes. It also covers the race
      // where the dialog closes while the load is still in flight.
      void task.then((loading) => loading.destroy()).catch(() => {})
    }
  }, [src, password, attempt])

  // A new document is a new set of pages to search.
  useEffect(() => {
    pageIndexes.current = new Map()
  }, [doc])

  useEffect(() => {
    if (loadState === 'failed') onLoadError?.()
  }, [loadState, onLoadError])

  /**
   * Reserve realistic room for every page before any of them has rendered.
   *
   * Pages rasterise lazily, so without this the whole document starts as a
   * stack of near-empty boxes: the scrollbar is a lie, `offsetTop` for a page
   * deep in the document is far short of its final value, and the content
   * jumps as pages fill in. One `getPage(1)` gives the stack its true height,
   * because a PDF's pages are all but always the same size — and any page that
   * is not corrects itself the moment it renders.
   */
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    doc
      .getPage(1)
      .then((first) => {
        if (cancelled) return
        const base = first.getViewport({ scale: 1 })
        setDefaultAspect(base.height / base.width)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc])

  // A new Fundstelle is a new question. Clearing the old marks stops the
  // previous passage from staying lit on a page the reader has left, and lets
  // the "open at page" fallback run again for the new target.
  useEffect(() => {
    foundRef.current = false
    setHit(null)
    setMissed([])
  }, [page, highlight])

  useEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect?.width) setFrame({ width: rect.width, height: rect.height || 0 })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [doc])

  const baseWidth = fitWidth({
    mode: fit,
    frameWidth: frame.width,
    frameHeight: frame.height,
    aspect: defaultAspect ?? PLACEHOLDER_PAGE_ASPECT,
    gutter: GUTTER,
    verticalPadding: FIT_PAGE_PADDING,
  })
  const targetWidth = frame.width > GUTTER ? baseWidth * zoom : 0

  /**
   * Zoom to `next`, keeping the point at (`clientX`, `clientY`) where it is —
   * the pointer for a pinch or a wheel, the middle of the frame for a button
   * or a key. Zooming about the top-left corner instead throws the reader off
   * the line they were reading on every step.
   */
  const zoomTo = useCallback((next: number, clientX?: number, clientY?: number) => {
    const target = clampZoom(next)
    const drawn = zoomRef.current
    if (Math.abs(target - drawn) < 1e-4) return
    const frameNode = scrollRef.current
    const content = contentRef.current
    if (frameNode && content) {
      const box = frameNode.getBoundingClientRect()
      const stack = content.getBoundingClientRect()
      const x = (clientX ?? box.left + box.width / 2) - box.left
      const y = (clientY ?? box.top + box.height / 2) - box.top
      const pending = anchorRef.current
      anchorRef.current = {
        x,
        y,
        // A pinch fires again before the last step has been laid out; anchor
        // to where the first step was going, not to a stale measurement.
        contentX: pending ? pending.contentX : x - (stack.left - box.left),
        contentY: pending ? pending.contentY : y - (stack.top - box.top),
        ratio: (pending ? pending.ratio : 1) * (target / drawn),
      }
    }
    zoomRef.current = target
    setZoom(target)
  }, [])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const frameNode = scrollRef.current
    const content = contentRef.current
    if (!anchor || !frameNode || !content) return
    anchorRef.current = null
    const box = frameNode.getBoundingClientRect()
    const stack = content.getBoundingClientRect()
    const stackTop = stack.top - box.top + frameNode.scrollTop
    const stackLeft = stack.left - box.left + frameNode.scrollLeft
    frameNode.scrollTop = stackTop + anchor.contentY * anchor.ratio - anchor.y
    frameNode.scrollLeft = stackLeft + anchor.contentX * anchor.ratio - anchor.x
  }, [targetWidth])

  const fitAgain = useCallback(() => {
    zoomRef.current = 1
    setZoom(1)
  }, [])

  useZoomGestures(scrollRef, { enabled: Boolean(doc), zoom, onZoom: zoomTo })

  const registerPage = useCallback((number: number, node: HTMLDivElement | null) => {
    if (node) pageRefs.current.set(number, node)
    else pageRefs.current.delete(number)
  }, [])

  const registerWidth = useCallback((number: number, width: number) => {
    pageWidths.current.set(number, width)
  }, [])

  // Marked only on the page they were stated for; with no page there is no
  // frame to draw a share of.
  const regionsOnPage = page && regions?.length ? regions : null

  /**
   * Put the cited region near the top of the frame — the same resting place a
   * located passage gets, measured the same way (see `scrollToRects`). A
   * region is a share of the page, so the page's rendered height is all the
   * geometry it needs.
   */
  const scrollToRegion = useCallback(
    (smooth: boolean) => {
      const frameNode = scrollRef.current
      const pageNode = page ? pageRefs.current.get(page) : undefined
      if (!frameNode || !pageNode || !regionsOnPage) return
      const top = Math.min(...regionsOnPage.map((region) => region.box[1]))
      const pageTop =
        pageNode.getBoundingClientRect().top - frameNode.getBoundingClientRect().top + frameNode.scrollTop
      const offset = pageTop + top * pageNode.clientHeight - frameNode.clientHeight * PASSAGE_SCROLL_OFFSET
      frameNode.scrollTo({ top: Math.max(0, offset), behavior: scrollBehavior(smooth) })
    },
    [page, regionsOnPage],
  )

  /**
   * Put a set of marks — a located passage, a search hit — near the top of the
   * frame.
   *
   * Scrolling to the PAGE and scrolling to the PASSAGE are different answers,
   * and only the second is what the click asked for — landing at the top of
   * page 12 when the sentence sits at its foot leaves the reader searching
   * exactly as the old iframe did.
   */
  const scrollToRects = useCallback((target: { page: number; rects: HighlightRect[] }, smooth: boolean) => {
    const frameNode = scrollRef.current
    const pageNode = pageRefs.current.get(target.page)
    const bounds = passageBounds(target.rects)
    if (!frameNode || !pageNode || !bounds) return
    // Measured against the FRAME, not read off `offsetTop`. `offsetTop` counts
    // from the nearest POSITIONED ancestor, and this scroller sets no position
    // — so the number included the dialog's header, and on a phone the whole
    // Fundstellen rail stacked above the document as well. The viewer then
    // scrolled that much too far and left the passage it had just found off the
    // top of the frame. Rects plus the current `scrollTop` are the same
    // measurement no matter what is above the frame. (A phone-viewport capture
    // of the citation viewer is the evidence; jsdom lays nothing out, so no
    // unit test can hold this.)
    const box = frameNode.getBoundingClientRect()
    const pageBox = pageNode.getBoundingClientRect()
    const unscaled = pageWidths.current.get(target.page)
    const scale = unscaled && pageBox.width ? pageBox.width / unscaled : 1
    const pageTop = pageBox.top - box.top + frameNode.scrollTop
    const top = pageTop + bounds.y * scale - frameNode.clientHeight * PASSAGE_SCROLL_OFFSET
    // Sideways too, once zoomed past the frame: a hit at the right edge of a
    // plan sheet is otherwise scrolled to and still off screen.
    const pageLeft = pageBox.left - box.left + frameNode.scrollLeft
    const left = pageLeft + (bounds.x + bounds.width / 2) * scale - frameNode.clientWidth / 2
    frameNode.scrollTo({
      top: Math.max(0, top),
      left: Math.max(0, left),
      behavior: scrollBehavior(smooth),
    })
  }, [])

  /** Scroll to the passage AND announce it — what a fresh citation deserves. */
  const revealPassage = useCallback(
    (target: PassageHit) => {
      setPing((previous) => previous + 1)
      scrollToRects(target, true)
    },
    [scrollToRects],
  )

  /**
   * Take the FIRST passage offered for this question, and only the first.
   *
   * Two pages can answer: the cited one and, once it has come up empty, its
   * neighbours. And one page can answer twice — a page that scrolls out of the
   * render band and back re-reads its text layer. Without this guard the second
   * answer scrolls and re-pulses, which means a reader who deliberately paged
   * away is dragged back to the citation for having scrolled too far.
   */
  const handlePassage = useCallback(
    (found: PassageHit) => {
      if (foundRef.current) return
      foundRef.current = true
      setHit(found)
      revealPassage(found)
    },
    [revealPassage],
  )

  /**
   * A page that read its text and did not hold the passage says so. The search
   * radius is derived from these misses, see {@link searchRadius}.
   */
  const handleMiss = useCallback((missedPage: number) => {
    setMissed((current) =>
      current.includes(missedPage) ? current : [...current, missedPage],
    )
  }, [])

  // How far either side of the cited page the passage is still looked for.
  const radius = searchRadius(page, missed, doc?.numPages ?? 0)

  /**
   * Re-apply the scroll once the page stack has settled.
   *
   * A page that has never rasterised only knows its height once
   * `defaultAspect` arrives or it enters the render band. Until then the pages
   * above the target are shorter than they will be, so the first scroll to a
   * passage deep in a long document lands well short of it. Correcting on the
   * next frame, without a pulse and without smooth scrolling (the first scroll
   * is still animating), settles it.
   */
  useEffect(() => {
    if (!hit || !defaultAspect) return
    const raf = requestAnimationFrame(() => scrollToRects(hit, false))
    return () => cancelAnimationFrame(raf)
  }, [hit, defaultAspect, scrollToRects])

  // Opening at a page is the answer when there is no passage to find, and the
  // starting point while the target page's text layer is still being read. A
  // located passage supersedes it. Re-apply once `defaultAspect` lands: the
  // first scroll runs while unrendered pages still have no height, so it
  // leaves the reader at the top of a document that then grows underneath
  // them (#430). A cited region is the same answer one step finer.
  useEffect(() => {
    if (!doc || !page || hit) return
    if (regionsOnPage) scrollToRegion(false)
    else pageRefs.current.get(page)?.scrollIntoView({ block: 'start' })
  }, [doc, page, hit, defaultAspect, regionsOnPage, scrollToRegion])

  /**
   * Which page the reader is on.
   *
   * One observer over the whole stack rather than a handler per scroll event:
   * a 200-page document would otherwise measure 200 rectangles per frame to
   * answer a question the browser is already computing.
   */
  useEffect(() => {
    const frameNode = scrollRef.current
    if (!doc || !frameNode || typeof IntersectionObserver === 'undefined') return
    // Which pages are in the band, kept ACROSS callbacks. A batch reports
    // changes — the page leaving and the page arriving — not the whole truth.
    const inBand = new Map<number, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number((entry.target as HTMLElement).dataset.page)
          if (Number.isFinite(number)) inBand.set(number, entry.isIntersecting)
        }
        const [first] = [...inBand]
          .filter(([, isInBand]) => isInBand)
          .map(([number]) => number)
          .sort((a, b) => a - b)
        // Lowest wins, so the moment a page boundary straddles the band the
        // counter reads as the page you are still leaving rather than flicking
        // forward and back across it.
        if (first) setCurrentPage(first)
      },
      { root: frameNode, rootMargin: CURRENT_PAGE_BAND },
    )
    pageRefs.current.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [doc])

  // Say where the reader is, once they have stopped moving.
  const position = doc ? t('viewer.pagePosition', { page: currentPage, count: doc.numPages }) : ''
  useEffect(() => {
    if (!position) return
    const timer = window.setTimeout(() => setAnnounced(position), ANNOUNCE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [position])

  /** Go to a page: its top edge to the top of the frame. */
  const goToPage = useCallback(
    (requested: number) => {
      const frameNode = scrollRef.current
      if (!doc || !frameNode) return
      const target = clampPage(requested, doc.numPages)
      const pageNode = pageRefs.current.get(target)
      if (!pageNode) return
      const top =
        pageNode.getBoundingClientRect().top - frameNode.getBoundingClientRect().top + frameNode.scrollTop
      // A smooth scroll passes through every page in between, and the counter
      // would read each of them out; the page asked for is the answer now.
      setCurrentPage(target)
      frameNode.scrollTo({ top: Math.max(0, top - 12), behavior: scrollBehavior(true) })
    },
    [doc],
  )

  // Bring the caller's point to the middle of the view. Keyed, so the same
  // point can be asked for twice (the reader scrolled away and asks again).
  const focusKey = focus ? `${focus.key}` : null
  const focusRef = useRef(focus)
  focusRef.current = focus
  useEffect(() => {
    const frameNode = scrollRef.current
    const focus = focusRef.current
    if (!focus || !doc || !frameNode) return
    const pageNode = pageRefs.current.get(clampPage(focus.page, doc.numPages))
    if (!pageNode) return
    const frameBox = frameNode.getBoundingClientRect()
    const pageBox = pageNode.getBoundingClientRect()
    const pointTop = pageBox.top - frameBox.top + frameNode.scrollTop + focus.y * pageBox.height
    frameNode.scrollTo({
      top: Math.max(0, pointTop - frameBox.height / 2),
      behavior: scrollBehavior(!focus.instant),
    })
  }, [focusKey, doc])

  // Say where the view is, once a frame at most, for whoever follows it.
  const onViewportRef = useRef(onViewport)
  onViewportRef.current = onViewport
  const reportsViewport = onViewport !== undefined
  useEffect(() => {
    const frameNode = scrollRef.current
    if (!frameNode || !doc || !reportsViewport) return
    let frame: number | null = null
    const report = () => {
      frame = null
      const frameBox = frameNode.getBoundingClientRect()
      const middle = frameBox.top + frameBox.height / 2
      for (const [number, node] of pageRefs.current) {
        const box = node.getBoundingClientRect()
        if (box.top <= middle && box.bottom >= middle && box.height > 0) {
          onViewportRef.current?.({ page: number, y: Math.min(1, Math.max(0, (middle - box.top) / box.height)) })
          return
        }
      }
    }
    const onScroll = () => {
      if (frame === null) frame = requestAnimationFrame(report)
    }
    frameNode.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      frameNode.removeEventListener('scroll', onScroll)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [doc, reportsViewport])

  /**
   * Read the reader's selection: what it says, which page it is on, and where
   * to hang the offer to quote it. Nothing selected inside the document
   * withdraws the offer.
   */
  const readSelection = useCallback((): void => {
    const frameNode = scrollRef.current
    const content = contentRef.current
    if (!(quoteFormat || onFindSimilar) || !frameNode || !content) return

    const selection = document.getSelection()
    const range =
      selection && !selection.isCollapsed && selection.rangeCount > 0
        ? selection.getRangeAt(0)
        : null
    const node = range
      ? range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement
      : null
    const text = range ? selection!.toString().trim() : ''
    // A selection outside this document is somebody else's, and a two-character
    // one is a mis-click rather than a quotation.
    if (!range || !node || !frameNode.contains(node) || text.length < MIN_QUOTE_LENGTH) {
      quotedRef.current = null
      return setQuote(null)
    }

    // Only a NEW selection clears the confirmation. Re-measuring after a zoom
    // must not wipe the "copied" the reader just earned.
    if (quotedRef.current !== text) {
      quotedRef.current = text
      setCopied('idle')
    }
    const rect = range.getBoundingClientRect()
    const origin = content.getBoundingClientRect()
    setQuote({
      text,
      page: Number(node.closest('[data-page]')?.getAttribute('data-page')) || currentPageRef.current,
      x: rect.left - origin.left,
      y: rect.top - origin.top,
    })
  }, [quoteFormat, onFindSimilar])

  /**
   * Ask on RELEASE, not on every `selectionchange`: mid-drag the offer would
   * chase the cursor across the page. `selectionchange` is still listened to,
   * for the opposite job — the moment the selection collapses, the offer goes.
   */
  useEffect(() => {
    const frameNode = scrollRef.current
    if (!(quoteFormat || onFindSimilar) || !frameNode) return

    const collapse = (): void => {
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) setQuote(null)
    }

    frameNode.addEventListener('pointerup', readSelection)
    frameNode.addEventListener('keyup', readSelection)
    document.addEventListener('selectionchange', collapse)
    return () => {
      frameNode.removeEventListener('pointerup', readSelection)
      frameNode.removeEventListener('keyup', readSelection)
      document.removeEventListener('selectionchange', collapse)
    }
  }, [quoteFormat, onFindSimilar, readSelection, doc])

  // The offer is placed in the page stack's coordinates, and a zoom step moves
  // every word under it. Re-measuring keeps it on the sentence.
  useEffect(() => {
    // The ref rather than the state, deliberately: this effect WRITES the
    // selection state, so reading it here would make the effect its own trigger.
    if (quotedRef.current) readSelection()
  }, [targetWidth, readSelection])

  const copyQuote = useCallback(async (): Promise<void> => {
    if (!quote || !quoteFormat) return
    try {
      await navigator.clipboard.writeText(quoteFormat({ text: quote.text, page: quote.page }))
      setCopied('done')
    } catch {
      // Blocked clipboard, insecure context, denied permission. Saying so in
      // the bar beats a silent button: the reader is about to paste.
      setCopied('failed')
    }
  }, [quote, quoteFormat])

  // Let the confirmation fade by itself.
  useEffect(() => {
    if (copied === 'idle') return
    const timer = window.setTimeout(() => setCopied('idle'), COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  // ---- Find in document --------------------------------------------------

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const queryTooShort = normalizePassage(searchedQuery).length < MIN_SEARCH_QUERY

  /**
   * Search every page's text layer for the query. The pages' text is read
   * once per document, through the same reader the passage search uses, and
   * kept: refining „Brand" to „Brandabschnitt" re-reads nothing. Page by page
   * and awaited, so a two-hundred-page document is searched without one long
   * task, and a newer query abandons an older one mid-document.
   */
  useEffect(() => {
    if (!doc || !searchOpen || queryTooShort) {
      setHits([])
      return
    }
    let cancelled = false
    setHits(null)
    const run = async (): Promise<void> => {
      const found: SearchHit[] = []
      for (let number = 1; number <= doc.numPages; number += 1) {
        let index = pageIndexes.current.get(number)
        if (!index) {
          const pdfPage = await doc.getPage(number)
          if (cancelled) return
          const items = await readPageTextItems(pdfPage)
          if (cancelled) return
          const unscaled = pdfPage.getViewport({ scale: 1 })
          pageWidths.current.set(number, unscaled.width)
          index = buildPassageIndex(pageTextChunks(items, unscaled.transform))
          pageIndexes.current.set(number, index)
        }
        for (const rects of findOccurrences(index, searchedQuery)) found.push({ page: number, rects })
      }
      if (cancelled) return
      setHits(found)
      // Start where the reader is, not at the top of the document.
      const ahead = found.findIndex((entry) => entry.page >= currentPageRef.current)
      setActiveHit(ahead === -1 ? 0 : ahead)
    }
    void run().catch(() => {
      if (!cancelled) setHits([])
    })
    return () => {
      cancelled = true
    }
  }, [doc, searchOpen, searchedQuery, queryTooShort])

  const shownHit = hits?.[activeHit] ?? null
  useEffect(() => {
    if (shownHit) scrollToRects(shownHit, true)
  }, [shownHit, scrollToRects])

  const stepHit = useCallback(
    (direction: 1 | -1) => {
      if (!hits?.length) return
      setActiveHit((current) => (current + direction + hits.length) % hits.length)
    },
    [hits],
  )

  const searchMarks = useMemo(() => {
    const byPage = new Map<number, Array<{ rects: HighlightRect[]; active: boolean }>>()
    hits?.forEach((entry, index) => {
      const list = byPage.get(entry.page) ?? []
      list.push({ rects: entry.rects, active: index === activeHit })
      byPage.set(entry.page, list)
    })
    return byPage
  }, [hits, activeHit])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    setSearchFocus((value) => value + 1)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
    setSearchedQuery('')
    // Back to the document, so the keys that move through it work again.
    scrollRef.current?.focus({ preventScroll: true })
  }, [])

  /**
   * The viewer's keys, while focus is inside it. Bound on the viewer's root,
   * so Cmd+F and Cmd+0 are taken from the browser only while the reader is in
   * the document, and two viewers on one screen never answer for each other.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!doc || event.defaultPrevented) return
      const target = event.target as HTMLElement
      const frameNode = scrollRef.current
      const action = viewerKeyAction(event, {
        inField: target.closest('input, textarea, [contenteditable="true"]') !== null,
        overflowsSideways: frameNode ? frameNode.scrollWidth > frameNode.clientWidth + 1 : false,
      })
      if (!action) return
      event.preventDefault()
      if (action.kind === 'search') return openSearch()
      if (action.kind === 'fit') return fitAgain()
      if (action.kind === 'zoom') return zoomTo(stepZoom(zoomRef.current, action.direction))
      const to = {
        next: currentPageRef.current + 1,
        previous: currentPageRef.current - 1,
        first: 1,
        last: doc.numPages,
      }[action.to]
      goToPage(to)
    },
    [doc, openSearch, fitAgain, zoomTo, goToPage],
  )

  const pages = useMemo(
    () => (doc ? Array.from({ length: doc.numPages }, (_, index) => index + 1) : []),
    [doc],
  )

  // A document is on screen once pdf.js has parsed it, not when the viewer
  // mounts. The kind and the renderer, never the name or the page count.
  useEffect(() => {
    if (doc) capturePosthog('document_opened', { kind: 'pdf', library: 'pdfjs' })
  }, [doc])

  // Every page that could hold this passage has read its text and none did.
  // Until all of them have answered the viewer says nothing, because "not
  // found" and "still looking" are different claims and only one is true yet.
  const candidatePages =
    doc && page && highlight
      ? pagesWithin(page, MAX_SEARCH_RADIUS, doc.numPages)
      : []
  const passageMissing =
    !hit && candidatePages.length > 0 && candidatePages.every((number) => missed.includes(number))

  const revealCited =
    hit || regionsOnPage
      ? () => {
          if (hit) return revealPassage(hit)
          setPing((previous) => previous + 1)
          scrollToRegion(true)
        }
      : undefined

  if (loadState === 'failed' && onLoadError) return null

  const Ground = ground === 'stage' ? InsetStage : HostGround

  if (loadState === 'failed' || loadState === 'locked' || loadState === 'wrong-password') {
    return (
      <div className={cn('@container flex min-h-0 min-w-0 flex-1 flex-col', REPLAY_BLOCK_CLASS, className)}>
        <Ground className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-4">
          {loadState === 'failed' ? (
            <PdfFailure
              href={page ? `${src}#page=${page}` : src}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          ) : (
            <PdfPasswordPrompt
              incorrect={loadState === 'wrong-password'}
              onSubmit={(value) => {
                setPassword(value)
                setAttempt((current) => current + 1)
              }}
            />
          )}
        </Ground>
      </div>
    )
  }

  return (
    <div
      className={cn('@container flex min-h-0 min-w-0 flex-1 flex-col', REPLAY_BLOCK_CLASS, className)}
      onKeyDown={onKeyDown}
    >
      <Ground className="flex min-h-0 flex-1 flex-row">
        {/* A rail of one thumbnail is a 150px column that says „1". */}
        {doc && railOpen && doc.numPages > 1 && (
          <PdfThumbnailRail
            doc={doc}
            pages={pages}
            currentPage={currentPage}
            defaultAspect={defaultAspect}
            onSelect={goToPage}
            className="@max-3xl:hidden"
          />
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Focusable on purpose. A bare scrollable div is not reachable by
              keyboard in most engines, so without a tabindex a keyboard-only
              reader could tab to the zoom buttons and still have no way to move
              through the document itself. `touch-pan-*`: one finger scrolls
              natively, two pinch the document rather than the page. */}
          <div
            ref={scrollRef}
            data-testid="pdf-scroll"
            tabIndex={0}
            role="group"
            aria-label={title}
            className="min-h-0 w-full flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain px-3 pt-4 pb-16 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            {/* PAGE-SHAPED while it loads: the same sheet a page is drawn on,
                at the width the first page will take and the ISO 216 proportion
                most documents here have, so the document arrives INTO it. */}
            {!doc && (
              <div className="flex flex-col items-center">
                <PageSheet
                  data-testid="pdf-page-placeholder"
                  className="flex w-full justify-center pt-16"
                  style={{
                    width: targetWidth || undefined,
                    aspectRatio: `1 / ${PLACEHOLDER_PAGE_ASPECT}`,
                  }}
                >
                  <span className="inline-flex items-center gap-2 self-start text-sm text-muted-foreground">
                    <Spinner size="sm" />
                    {t('viewer.loading')}
                  </span>
                </PageSheet>
              </div>
            )}
            {/* `relative`: the quote bar is positioned against this stack, so it
                travels with the words it is offering to quote. `w-fit min-w-full`:
                zoomed past the frame, the stack is as wide as its widest page and
                scrolls sideways from its left edge instead of being clipped on
                both. */}
            <div ref={contentRef} className="relative mx-auto flex w-fit min-w-full flex-col items-center gap-3">
              {quote && (quoteFormat || onFindSimilar) && (
                <QuoteBar
                  selection={quote}
                  state={copied}
                  onCopy={quoteFormat ? () => void copyQuote() : undefined}
                  onFindSimilar={
                    onFindSimilar && quote.text.length >= SIMILAR_PASSAGE_TEXT_MIN
                      ? () => onFindSimilar({ text: quote.text, page: quote.page })
                      : undefined
                  }
                />
              )}
              {doc &&
                pages.map((number) => (
                  <PdfPageCanvas
                    key={number}
                    doc={doc}
                    pageNumber={number}
                    label={t('viewer.pageLabel', { page: number })}
                    targetWidth={targetWidth}
                    defaultAspect={defaultAspect}
                    highlight={page && Math.abs(number - page) <= radius ? highlight : null}
                    highlightColor={highlightColor}
                    marks={hit?.page === number ? hit.rects : null}
                    searchMarks={searchMarks.get(number) ?? null}
                    regions={number === page ? regionsOnPage : null}
                    overlay={pageOverlay?.(number)}
                    fuzzy={hit?.page === number && hit.fuzzy}
                    ping={ping}
                    onPassage={handlePassage}
                    onMiss={handleMiss}
                    onBase={registerWidth}
                    registerRef={registerPage}
                  />
                ))}
            </div>
          </div>

          {/* Over the head of the stage: what is being looked for, and the one
              thing worth saying about a citation — that its passage could not
              be found. Over the document rather than in a row above it, so the
              row never steals the document's height. */}
          {(searchOpen || passageMissing) && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-2 px-3">
              {searchOpen && (
                <PdfSearchBar
                  key={searchFocus}
                  query={query}
                  onQuery={setQuery}
                  count={hits === null ? null : hits.length}
                  active={activeHit}
                  onStep={stepHit}
                  onClose={closeSearch}
                  tooShort={normalizePassage(query).length < MIN_SEARCH_QUERY}
                />
              )}
              {passageMissing && !searchOpen && (
                // The reader clicked a Fundstelle and nothing lit up. Without
                // this the viewer let them conclude what they liked from that.
                // It is none of those: the page is right and the sentence
                // could not be located on it.
                <FloatingNote data-testid="pdf-passage-missing">
                  <AlertTriangle aria-hidden />
                  {t('viewer.passageNotFound')}
                </FloatingNote>
              )}
            </div>
          )}

          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
            <PdfControls
              pageCount={doc ? doc.numPages : null}
              currentPage={currentPage}
              onPage={goToPage}
              onRevealPassage={revealCited}
              zoom={zoom}
              fit={fit}
              onZoomStep={(direction) => zoomTo(stepZoom(zoomRef.current, direction))}
              onResetZoom={fitAgain}
              onToggleFit={() => {
                setFit((current) => (current === 'width' ? 'page' : 'width'))
                fitAgain()
              }}
              searchOpen={searchOpen}
              onToggleSearch={() => (searchOpen ? closeSearch() : openSearch())}
              railOpen={railOpen}
              onToggleRail={() => setRailOpen((open) => !open)}
              lead={toolbarLead}
            />
          </div>
        </div>
      </Ground>
      <span className="sr-only" role="status" aria-live="polite" data-testid="pdf-page-announcement">
        {announced}
      </span>
    </div>
  )
}

/** The ground when the host lays its own: layout only, no material. */
function HostGround({ className, children }: { className?: string; children?: ReactNode }): JSX.Element {
  return <div className={cn('relative min-h-0 min-w-0', className)}>{children}</div>
}

/**
 * pdf.js could not open the document: a blocked worker, a corrupt file, a
 * stream that refused. Said on the stage, where the document would have been,
 * with the two things a reader can do about it — try again, or hand the file to
 * the browser's own viewer, which still honours `#page=N` and reads things
 * pdf.js will not. Not a frame of that viewer in place of this one: a frame is
 * what shows blank on Android Chrome, which has no inline PDF renderer.
 */
const PdfFailure: FC<{ href: string; onRetry: () => void }> = ({ href, onRetry }) => {
  const t = useTranslations('knowledge')
  return (
    <EmptyState
      variant="bare"
      icon={AlertTriangle}
      tone="warning"
      title={t('viewer.failedTitle')}
      description={t('viewer.failedBody')}
      data-testid="pdf-load-failed"
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw aria-hidden />
            {t('viewer.retry')}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => capturePosthog('document_opened', { kind: 'pdf', library: 'browser' })}
            >
              <ExternalLink aria-hidden />
              {t('viewer.openInBrowser')}
            </a>
          </Button>
        </div>
      }
    />
  )
}

/**
 * The document is encrypted. Ask for its password here, on the stage, rather
 * than calling it a failure: the office has the password, usually in the email
 * the document came with. The password goes to pdf.js and nowhere else — not
 * to the server, not into storage — and is forgotten with the viewer.
 */
const PdfPasswordPrompt: FC<{ incorrect: boolean; onSubmit: (password: string) => void }> = ({
  incorrect,
  onSubmit,
}) => {
  const t = useTranslations('knowledge')
  const [value, setValue] = useState('')
  return (
    <EmptyState
      variant="bare"
      icon={LockKeyhole}
      title={t('viewer.passwordTitle')}
      description={t('viewer.passwordBody')}
      data-testid="pdf-password"
      action={
        <form
          className="flex w-full max-w-xs flex-col items-stretch gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (value) onSubmit(value)
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            autoFocus
            enterKeyHint="go"
            aria-label={t('viewer.passwordLabel')}
            placeholder={t('viewer.passwordLabel')}
            aria-invalid={incorrect || undefined}
            aria-describedby={incorrect ? 'pdf-password-error' : undefined}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {incorrect && (
            <p id="pdf-password-error" role="alert" className="text-destructive text-left text-xs">
              {t('viewer.passwordIncorrect')}
            </p>
          )}
          <Button type="submit" size="sm" disabled={!value}>
            {t('viewer.passwordSubmit')}
          </Button>
        </form>
      }
    />
  )
}

/**
 * The offer that turns a selection into a citation.
 *
 * Anchored to the selection rather than parked in the toolbar, because the
 * gesture and the offer belong together: the reader has just dragged across a
 * sentence and their eyes are on it. One action, in the reader's own language
 * of what they are doing — not "copy text", which the browser already does,
 * but "copy this AS A CITATION", with the document and page the viewer knows
 * and their clipboard otherwise would not.
 *
 * `onMouseDown` is prevented on purpose: the default would move focus and
 * collapse the very selection the button exists to act on, so the click would
 * copy nothing.
 */
const QuoteBar: FC<{
  selection: QuoteSelection
  state: 'idle' | 'done' | 'failed'
  /** Copy the selection as a citation; absent where the viewer is not citing anything. */
  onCopy?: () => void
  /** Look for passages like the selection; absent where nobody asked for it, or the selection is too short. */
  onFindSimilar?: () => void
}> = ({ selection, state, onCopy, onFindSimilar }) => {
  const t = useTranslations('knowledge')
  const label =
    state === 'done'
      ? t('viewer.quoteCopied')
      : state === 'failed'
        ? t('viewer.copyFailed')
        : t('viewer.copyQuote')
  return (
    <div
      data-testid="pdf-quote-bar"
      className="absolute z-10 -translate-y-full pb-1.5"
      // Clamped at the left edge: a selection that starts in the page's gutter
      // would otherwise hang the bar outside the frame and clip it.
      style={{ left: Math.max(0, selection.x), top: selection.y }}
    >
      <span className="flex items-center gap-1.5">
        {onCopy && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onCopy}
            // `bg-card` is load-bearing, not decoration: the outline variant is
            // transparent, and this bar floats over the rendered PAGE, which is
            // paper-white in both themes. In dark mode that put near-white label
            // text on white paper — a control that was, measurably, invisible
            // exactly where it is offered.
            className="bg-card shadow-sm"
          >
            {state === 'done' ? (
              <Check aria-hidden className="size-3.5" />
            ) : (
              <Quote aria-hidden className="size-3.5" />
            )}
            {label}
          </Button>
        )}
        {onFindSimilar && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onFindSimilar}
            // On paper-white, as the copy button beside it (see `bg-card` above).
            className="bg-card shadow-sm"
            data-testid="pdf-find-similar"
          >
            <TextSearch aria-hidden className="size-3.5" />
            {t('viewer.findSimilar')}
          </Button>
        )}
      </span>
    </div>
  )
}


interface PdfPageCanvasProps {
  doc: PDFDocumentProxy
  pageNumber: number
  /** "Page 3", for assistive technology moving through the pages. */
  label: string
  targetWidth: number
  /** Page 1's aspect, so an unrendered page still reserves the right height. */
  defaultAspect: number | null
  highlight?: string | null
  highlightColor?: string
  marks: HighlightRect[] | null
  /** The reader's own search hits on this page; `active` is the one on screen. */
  searchMarks: Array<{ rects: HighlightRect[]; active: boolean }> | null
  /** The cited region's boxes, when this is the page they were stated for. */
  regions: readonly PageRegion[] | null
  /** The caller's own marks on this page (see `PdfDocumentViewProps.pageOverlay`). */
  overlay?: ReactNode
  /** The marks are a guess — see {@link PassageHit.fuzzy}. */
  fuzzy: boolean
  ping: number
  onPassage: (hit: PassageHit) => void
  /** This page read its text and the passage is not on it. */
  onMiss: (page: number) => void
  /** The page's unscaled width, once known. */
  onBase: (page: number, width: number) => void
  registerRef: (page: number, node: HTMLDivElement | null) => void
}

/**
 * One page: a canvas sized to the frame, rasterised while near the viewport,
 * with the passage marks laid over it in the page's own coordinate space.
 *
 * The page's SIZE follows the zoom at once and its BITMAP follows a beat later:
 * the canvas is stretched by CSS to the new size while a pinch is still moving,
 * and re-drawn sharp once it stops. Re-rasterising on every frame of a pinch is
 * a full render per page per frame, and the pinch stutters.
 */
const PdfPageCanvas: FC<PdfPageCanvasProps> = ({
  doc,
  pageNumber,
  label,
  targetWidth,
  defaultAspect,
  highlight,
  highlightColor,
  marks,
  searchMarks,
  regions,
  overlay,
  fuzzy,
  ping,
  onPassage,
  onMiss,
  onBase,
  registerRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  // The page proxy currently held open, so eviction can release its caches.
  const openedPage = useRef<PDFPageProxy | null>(null)
  // The page's unscaled size, learned once and kept through eviction, so a
  // page that has been seen keeps reserving the right room and every scale is
  // arithmetic rather than a round trip to pdf.js.
  const [base, setBase] = useState<{ width: number; height: number } | null>(null)
  const scale = base && targetWidth > 0 ? targetWidth / base.width : 1

  useEffect(() => {
    if (base) onBase(pageNumber, base.width)
  }, [base, pageNumber, onBase])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setNear(entry.isIntersecting)
      },
      { rootMargin: PRERENDER_MARGIN },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  /**
   * Rasterise. Keyed on the zoom-driven `targetWidth`, because that is the only
   * thing that changes what the bitmap should look like.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!near || targetWidth <= 0) {
      // Release the bitmap AND the page's own caches for a page that scrolled
      // out of the band. Zeroing the canvas alone leaves pdf.js holding the
      // page's operator list and text content, which for a long document is the
      // larger half of what the eviction band exists to bound. The sheet keeps
      // its height, so nothing moves under the reader.
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      const opened = openedPage.current
      openedPage.current = null
      opened?.cleanup()
      return
    }

    let cancelled = false
    let cancelRender: (() => void) | null = null

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      openedPage.current = pdfPage
      const unscaled = pdfPage.getViewport({ scale: 1 })
      setBase((current) =>
        current && current.width === unscaled.width && current.height === unscaled.height
          ? current
          : { width: unscaled.width, height: unscaled.height },
      )
      if (!canvas) return

      // Rasterise at device resolution and let CSS size it back down, or the
      // page is soft on exactly the retina screens people read plans on.
      const ratio = Math.min(
        typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
        MAX_PIXEL_RATIO,
      )
      const viewport = pdfPage.getViewport({ scale: (targetWidth / unscaled.width) * ratio })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const task = pdfPage.render({ canvas, viewport })
      cancelRender = () => task.cancel()
      await task.promise.catch(() => {})
    }

    // A page that cannot be drawn must not take the dialog down with it — the
    // other pages, and the document, are still worth reading. The reason still
    // has to be reachable, or "one blank page" is an unfalsifiable bug report.
    const start = (): void => {
      void run().catch((error: unknown) => {
        if (process.env.NODE_ENV === 'development') {
          console.debug(`[pdf] page ${pageNumber} failed to render`, error)
        }
      })
    }
    // A page with a bitmap already is being zoomed: keep stretching the old
    // bitmap until the zoom settles. A blank page draws at once.
    const hasBitmap = Boolean(canvas && canvas.width > 0)
    const timer = hasBitmap ? window.setTimeout(start, RERASTER_DELAY_MS) : null
    if (!hasBitmap) start()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      cancelRender?.()
    }
  }, [doc, pageNumber, targetWidth, near])

  /**
   * Find the cited passage. Deliberately NOT keyed on `targetWidth`.
   *
   * Matching once produced the rectangles for good: they are in unscaled page
   * space, and the overlay multiplies them by the current scale. Re-running on
   * every zoom step would re-announce the hit, so each click of the zoom
   * control would drag a reader who had deliberately scrolled to page 30 back
   * to the citation and replay the arrival pulse at them.
   */
  useEffect(() => {
    if (!near || !highlight) return
    let cancelled = false

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      const unscaled = pdfPage.getViewport({ scale: 1 })
      const items = await readPageTextItems(pdfPage)
      if (cancelled) return
      const match = locatePassage(pageTextChunks(items, unscaled.transform), highlight)
      if (cancelled) return
      if (match)
        onPassage({
          page: pageNumber,
          rects: match.rects,
          fuzzy: match.matcher !== 'exact' && match.matcher !== 'anchored',
        })
      // Saying "not here" is what lets the viewer look next door. A page that
      // stayed silent is indistinguishable from one still reading its text.
      else onMiss(pageNumber)
    }

    // A page with no readable text layer — a scan — is a supported outcome, not
    // an error: the viewer simply opens at the page with nothing marked.
    void run().catch((error: unknown) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[pdf] page ${pageNumber} passage lookup failed`, error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [doc, pageNumber, near, highlight, onPassage, onMiss])

  /**
   * Lay the page's own text over the bitmap while the page is in the band.
   *
   * Keyed on neither zoom nor the passage: pdf.js positions every run as a
   * percentage of the page box and sizes it from `--total-scale-factor`, so
   * zooming is a CSS variable rather than a re-read, and the selection the
   * reader had survives it. It is also what a screen reader reads: the canvas
   * is a picture, the layer is the page's words in reading order.
   */
  useEffect(() => {
    const container = textLayerRef.current
    if (!near || !container) return
    let cancelled = false
    let layer: TextLayerHandle | null = null

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      layer = await renderTextLayer(pdfPage, container)
      // Torn down mid-render: the handle arrived after the cleanup ran, so it
      // is this branch's job to release it or the runs stay over the canvas.
      if (cancelled) layer.destroy()
    }

    // A page whose text cannot be laid out still renders and can still be read;
    // only selecting on it is lost, and taking the viewer down would lose both.
    void run().catch((error: unknown) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[pdf] page ${pageNumber} text layer failed`, error)
      }
    })
    return () => {
      cancelled = true
      layer?.destroy()
    }
  }, [doc, pageNumber, near])

  // Its own measured shape once it has rendered; page 1's until then.
  const effectiveAspect = base ? base.height / base.width : defaultAspect
  const height = effectiveAspect && targetWidth ? targetWidth * effectiveAspect : undefined

  return (
    <PageSheet
      ref={(node) => {
        containerRef.current = node
        registerRef(pageNumber, node)
      }}
      data-page={pageNumber}
      role="group"
      aria-label={label}
      style={{ width: targetWidth || undefined, height }}
    >
      <canvas ref={canvasRef} aria-hidden className="block h-full w-full" />
      {/* The page's text, transparent and positioned over its own glyphs. It
          carries no pixels — its whole job is that a drag selects the sentence,
          Cmd-C copies it, a screen reader reads it and the search finds it,
          which a canvas alone silently refuses. `--total-scale-factor` is the
          zoom: pdf.js writes the runs in page units and multiplies by this, so
          the layer re-scales without being rebuilt. */}
      <div
        ref={textLayerRef}
        data-testid="pdf-text-layer"
        className="pdf-text-layer"
        style={{ ['--total-scale-factor' as string]: scale } as CSSProperties}
      />
      {regions && <RegionMarks regions={regions} color={highlightColor} ping={ping} />}
      {overlay && <div className="pointer-events-none absolute inset-0 z-20">{overlay}</div>}
      {searchMarks?.flatMap((entry, entryIndex) =>
        entry.rects.map((rect, index) => (
          <span
            key={`search-${entryIndex}-${index}`}
            data-testid="search-mark"
            data-active={entry.active || undefined}
            aria-hidden
            className={cn('pdf-search-hit pointer-events-none absolute', entry.active && 'pdf-search-hit--active')}
            style={{
              left: rect.x * scale,
              top: rect.y * scale,
              width: rect.width * scale,
              height: rect.height * scale,
            }}
          />
        )),
      )}
      {marks?.map((rect, index) => (
        <span
          // Remounting on each ping is what replays the arrival animation.
          key={`${ping}-${index}`}
          data-testid="passage-mark"
          data-fuzzy={fuzzy || undefined}
          aria-hidden
          className={cn(
            'passage-highlight animate-passage-ping motion-reduce:animate-none pointer-events-none absolute',
            fuzzy && 'passage-highlight--fuzzy'
          )}
          style={
            {
              left: rect.x * scale,
              top: rect.y * scale,
              width: rect.width * scale,
              height: rect.height * scale,
              ...(highlightColor ? { ['--passage-tint' as string]: highlightColor } : {}),
            } as CSSProperties
          }
        />
      ))}
    </PageSheet>
  )
}
