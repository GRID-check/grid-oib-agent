'use client'

/**
 * The in-app PDF renderer, and the reason a citation can point at a SENTENCE.
 *
 * This replaced a plain `<iframe>` on the browser's built-in viewer. That frame
 * was opaque by construction — the app could hand it `#page=12` and nothing
 * else: it could not read where the reader was, could not scroll it, and above
 * all could not draw on it. So a citation that knew exactly which passage the
 * answer leaned on could only ever say "page 12", and the reader arrived at a
 * wall of text with the actual work — find the sentence — still to do. Every
 * click paid that tax, on every citation, in a product whose whole promise is
 * that its claims are checkable.
 *
 * Rendering the page ourselves is what buys the text layer, and the text layer
 * is what turns the snippet the citation already carries into coordinates (see
 * `passage-highlight.ts` for the matching, `pdf-text-chunks.ts` for the
 * geometry). Nothing new is asked of the backend: the data was always there,
 * the iframe was simply the wrong instrument to spend it on.
 *
 * Pages rasterise only while near the viewport and drop their bitmap when they
 * leave, because a 200-page Einreichplan held at device resolution is gigabytes
 * of canvas — the naive version does not survive the documents this product is
 * for.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from 'react'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { AlertTriangle, Crosshair, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import {
  documentParameters,
  loadPdfjs,
  renderTextLayer,
  type TextLayerHandle,
} from '../lib/pdfjs-runtime'
import { pageTextChunks } from '../lib/pdf-text-chunks'
import { locatePassage, passageBounds, type HighlightRect } from '../lib/passage-highlight'

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
  className?: string
}

/** Zoom steps, as multiples of fit-to-width. */
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2, 3]

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

interface PassageHit {
  page: number
  rects: HighlightRect[]
}

export const PdfDocumentView: FC<PdfDocumentViewProps> = ({
  src,
  title,
  page,
  highlight,
  highlightColor,
  className,
}) => {
  const t = useTranslations('knowledge')
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [failed, setFailed] = useState(false)
  const [frameWidth, setFrameWidth] = useState(0)
  const [zoomStep, setZoomStep] = useState(ZOOM_STEPS.indexOf(1))
  const [hit, setHit] = useState<PassageHit | null>(null)
  // How far either side of the cited page the passage is still looked for. See
  // `handleMiss`: it stays at 0 until the cited page itself comes up empty.
  const [radius, setRadius] = useState(0)
  // Page 1's shape, used to reserve room for pages that have not rasterised.
  const [defaultAspect, setDefaultAspect] = useState<number | null>(null)
  // Bumped to replay the arrival animation — a CSS animation only runs on
  // mount, so re-pinging means remounting the marks.
  const [ping, setPing] = useState(0)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Whether THIS question has already been answered, read synchronously so two
  // pages reporting a hit in the same tick cannot both act on it.
  const foundRef = useRef(false)
  const pageRefs = useRef(new Map<number, HTMLDivElement>())
  // The scale each page last rendered at, so a rectangle in page coordinates
  // can be turned into a scroll offset at the CURRENT zoom rather than the one
  // that happened to be set when the passage was found.
  const pageScales = useRef(new Map<number, number>())

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setFailed(false)
    const task = loadPdfjs().then((pdfjs) => pdfjs.getDocument(documentParameters(src)))
    task
      .then((loading) => loading.promise)
      .then((loaded) => {
        if (!cancelled) setDoc(loaded)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      // Tearing down the LOADING TASK is what releases the document and the
      // worker's copy of it — a document left open holds its page cache, which
      // for a scanned plan set is tens of megabytes. It also covers the race
      // where the dialog closes while the load is still in flight.
      void task.then((loading) => loading.destroy()).catch(() => {})
    }
  }, [src])

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
    setRadius(0)
  }, [page, highlight])

  useEffect(() => {
    const node = scrollRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setFrameWidth(width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [doc])

  const zoom = ZOOM_STEPS[zoomStep] ?? 1
  const targetWidth = frameWidth > GUTTER ? (frameWidth - GUTTER) * zoom : 0

  const registerPage = useCallback((number: number, node: HTMLDivElement | null) => {
    if (node) pageRefs.current.set(number, node)
    else pageRefs.current.delete(number)
  }, [])

  const registerScale = useCallback((number: number, scale: number) => {
    pageScales.current.set(number, scale)
  }, [])

  /**
   * Put a located passage near the top of the frame.
   *
   * Scrolling to the PAGE and scrolling to the PASSAGE are different answers,
   * and only the second is what the click asked for — landing at the top of
   * page 12 when the sentence sits at its foot leaves the reader searching
   * exactly as the old iframe did.
   *
   * Split from the pulse because the two are wanted at different times: the
   * scroll has to be re-applied once the page stack settles (see below), and
   * re-pulsing on every correction would strobe the mark.
   */
  const scrollToPassage = useCallback((target: PassageHit, smooth: boolean) => {
    const frame = scrollRef.current
    const pageNode = pageRefs.current.get(target.page)
    const bounds = passageBounds(target.rects)
    if (!frame || !pageNode || !bounds) return
    const scale = pageScales.current.get(target.page) ?? 1
    // Measured against the FRAME, not read off `offsetTop`. `offsetTop` counts
    // from the nearest POSITIONED ancestor, and this scroller sets no position
    // — so the number included the dialog's header, and on a phone the whole
    // Fundstellen rail stacked above the document as well. The viewer then
    // scrolled that much too far and left the passage it had just found off the
    // top of the frame: the reader clicked a citation and arrived at blank
    // paper. Rects plus the current `scrollTop` are the same measurement no
    // matter what is above the frame, and stay correct mid-animation because
    // both are read in the same instant. (`visual/screenshots/
    // citation-viewer.mobile.*` is the evidence; jsdom lays nothing out, so no
    // unit test can hold this.)
    const pageTop =
      pageNode.getBoundingClientRect().top - frame.getBoundingClientRect().top + frame.scrollTop
    const top = pageTop + bounds.y * scale - frame.clientHeight * PASSAGE_SCROLL_OFFSET
    frame.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  /** Scroll to the passage AND announce it — what a fresh citation deserves. */
  const revealPassage = useCallback(
    (target: PassageHit) => {
      setPing((previous) => previous + 1)
      scrollToPassage(target, true)
    },
    [scrollToPassage],
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
   * Widen the search by one page when the cited page has no such passage.
   *
   * The page number is somebody else's arithmetic: retrieval counts sheets, and
   * a document whose own numbering starts after a cover page — which is most of
   * them — is off by one against it. That mismatch used to cost the reader the
   * entire feature, silently: the viewer opened at the wrong page with nothing
   * marked, indistinguishable from a passage that could not be found at all.
   *
   * One page either side, and no further. The matchers are strict enough that a
   * neighbour either holds the quoted sentence or holds nothing, so looking next
   * door cannot invent a hit — but three pages out is no longer an off-by-one,
   * it is a different passage that happens to read alike.
   */
  const handleMiss = useCallback(
    (missed: number) => {
      if (page && missed === page) setRadius((current) => Math.max(current, 1))
    },
    [page],
  )

  /**
   * Re-apply the scroll once the page stack has settled.
   *
   * `scrollToPassage` measures `pageNode.offsetTop`, and a page that has never
   * rasterised only knows its height once `defaultAspect` arrives or it enters
   * the render band. Until then the pages above the target are shorter than
   * they will be, so the first scroll to a passage deep in a long document
   * lands well short of it — and then the content grows underneath the reader
   * as those pages fill in. Correcting on the next frame, without a pulse and
   * without smooth scrolling (the first scroll is still animating), settles it.
   */
  useEffect(() => {
    if (!hit || !defaultAspect) return
    const frame = requestAnimationFrame(() => scrollToPassage(hit, false))
    return () => cancelAnimationFrame(frame)
  }, [hit, defaultAspect, scrollToPassage])

  // Opening at a page is the answer when there is no passage to find, and the
  // starting point while the target page's text layer is still being read. A
  // located passage supersedes it. Re-apply once `defaultAspect` lands: the
  // first scroll runs while unrendered pages still have no height, so it
  // leaves the reader at the top of a document that then grows underneath
  // them (#430).
  useEffect(() => {
    if (!doc || !page || hit) return
    pageRefs.current.get(page)?.scrollIntoView({ block: 'start' })
  }, [doc, page, hit, defaultAspect])

  const pages = useMemo(
    () => (doc ? Array.from({ length: doc.numPages }, (_, index) => index + 1) : []),
    [doc],
  )

  if (failed) {
    return (
      <PdfFallbackFrame
        src={src}
        title={title}
        page={page}
        hasPassage={Boolean(highlight)}
        className={className}
      />
    )
  }

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-2', className)}>
      {/* `flex-wrap`: this row holds a page count, a "jump to the passage"
          button and the zoom group, and on a phone — where each of those grows
          to the 44px touch floor — they add up past the viewport. Unwrapped, the
          row pushed the zoom control off the right edge and took the whole PAGE
          horizontal with it (measured 445px inside 390), so reading a cited
          passage on a phone meant scrolling the document sideways to find the
          controls for it. Wrapping costs one line and only when it is needed. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {doc ? t('viewer.pageCount', { count: doc.numPages }) : t('viewer.loading')}
        </span>
        <span className="flex-1" />
        {hit && (
          // After scrolling away — or after a rail jump to another Fundstelle —
          // the way back is one control, not a hunt.
          <Button type="button" variant="outline" size="sm" onClick={() => revealPassage(hit)}>
            <Crosshair aria-hidden className="size-3.5" />
            {t('viewer.toPassage')}
          </Button>
        )}
        <ButtonGroup>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setZoomStep((step) => Math.max(0, step - 1))}
            disabled={zoomStep === 0}
            aria-label={t('viewer.zoomOut')}
          >
            <Minus aria-hidden className="size-3.5" />
          </Button>
          <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setZoomStep((step) => Math.min(ZOOM_STEPS.length - 1, step + 1))}
            disabled={zoomStep === ZOOM_STEPS.length - 1}
            aria-label={t('viewer.zoomIn')}
          >
            <Plus aria-hidden className="size-3.5" />
          </Button>
        </ButtonGroup>
      </div>

      {/* Focusable on purpose. This scroller holds no focusable children, and a
          bare scrollable div is not reachable by keyboard in most engines — so
          without a tabindex a keyboard-only reader could tab to the zoom
          buttons and still have no way to move through the document itself. */}
      <div
        ref={scrollRef}
        data-testid="pdf-scroll"
        tabIndex={0}
        role="group"
        aria-label={title}
        className="min-h-0 w-full flex-1 overflow-auto overscroll-contain rounded-lg border border-border bg-surface-sunken p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {!doc && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            {t('viewer.loading')}
          </div>
        )}
        <div className="flex flex-col items-center gap-3">
          {doc &&
            pages.map((number) => (
              <PdfPageCanvas
                key={number}
                doc={doc}
                pageNumber={number}
                targetWidth={targetWidth}
                defaultAspect={defaultAspect}
                highlight={page && Math.abs(number - page) <= radius ? highlight : null}
                highlightColor={highlightColor}
                marks={hit?.page === number ? hit.rects : null}
                ping={ping}
                onPassage={handlePassage}
                onMiss={handleMiss}
                onScale={registerScale}
                registerRef={registerPage}
              />
            ))}
        </div>
      </div>
    </div>
  )
}

interface PdfPageCanvasProps {
  doc: PDFDocumentProxy
  pageNumber: number
  targetWidth: number
  /** Page 1's aspect, so an unrendered page still reserves the right height. */
  defaultAspect: number | null
  highlight?: string | null
  highlightColor?: string
  marks: HighlightRect[] | null
  ping: number
  onPassage: (hit: PassageHit) => void
  /** This page read its text and the passage is not on it. */
  onMiss: (page: number) => void
  onScale: (page: number, scale: number) => void
  registerRef: (page: number, node: HTMLDivElement | null) => void
}

/**
 * One page: a canvas sized to the frame, rasterised while near the viewport,
 * with the passage marks laid over it in the page's own coordinate space.
 */
const PdfPageCanvas: FC<PdfPageCanvasProps> = ({
  doc,
  pageNumber,
  targetWidth,
  defaultAspect,
  highlight,
  highlightColor,
  marks,
  ping,
  onPassage,
  onMiss,
  onScale,
  registerRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  // The page proxy currently held open, so eviction can release its caches.
  const openedPage = useRef<PDFPageProxy | null>(null)
  // Page aspect survives eviction, so a page that has been seen once keeps
  // reserving the right amount of room and the scrollbar stops jumping.
  const [aspect, setAspect] = useState<number | null>(null)
  const [scale, setScale] = useState(1)

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
      // larger half of what the eviction band exists to bound. The placeholder
      // keeps its height, so nothing moves under the reader.
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
      const base = pdfPage.getViewport({ scale: 1 })
      const pageScale = targetWidth / base.width
      setAspect(base.height / base.width)
      setScale(pageScale)
      onScale(pageNumber, pageScale)
      if (!canvas) return

      // Rasterise at device resolution and let CSS size it back down, or the
      // page is soft on exactly the retina screens people read plans on.
      const ratio = Math.min(
        typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
        MAX_PIXEL_RATIO,
      )
      const viewport = pdfPage.getViewport({ scale: pageScale * ratio })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const task = pdfPage.render({ canvas, viewport })
      cancelRender = () => task.cancel()
      await task.promise.catch(() => {})
    }

    // A page that cannot be drawn must not take the dialog down with it — the
    // other pages, and the document, are still worth reading. The reason still
    // has to be reachable, or "one blank page" is an unfalsifiable bug report.
    void run().catch((error: unknown) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[pdf] page ${pageNumber} failed to render`, error)
      }
    })
    return () => {
      cancelled = true
      cancelRender?.()
    }
  }, [doc, pageNumber, targetWidth, near, onScale])

  /**
   * Find the cited passage. Deliberately NOT keyed on `targetWidth`.
   *
   * Matching once produced the rectangles for good: they are in unscaled page
   * space, and the overlay multiplies them by the current scale. Re-running on
   * every zoom step would be wasted work, and worse — it re-announces the hit,
   * so each click of the zoom control would drag a reader who had deliberately
   * scrolled to page 30 back to the citation and replay the arrival pulse at
   * them. The passage is found once per (page, snippet); the zoom only changes
   * how big it is drawn.
   */
  useEffect(() => {
    if (!near || !highlight) return
    let cancelled = false

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      const base = pdfPage.getViewport({ scale: 1 })
      const content = await pdfPage.getTextContent()
      if (cancelled) return
      // `TextMarkedContent` entries carry structure, not text; `'str' in item`
      // narrows to the runs that have any, without a cast.
      const items = content.items.flatMap((item) =>
        'str' in item
          ? [
              {
                str: item.str,
                width: item.width,
                height: item.height,
                transform: item.transform.map(Number),
              },
            ]
          : [],
      )
      const match = locatePassage(pageTextChunks(items, base.transform), highlight)
      if (cancelled) return
      if (match) onPassage({ page: pageNumber, rects: match.rects })
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
   * reader had survives it.
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
  const effectiveAspect = aspect ?? defaultAspect
  const height = effectiveAspect && targetWidth ? targetWidth * effectiveAspect : undefined

  return (
    <div
      ref={(node) => {
        containerRef.current = node
        registerRef(pageNumber, node)
      }}
      data-page={pageNumber}
      className="relative shrink-0 bg-white shadow-sm ring-1 ring-border"
      style={{ width: targetWidth || undefined, height }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* The page's text, transparent and positioned over its own glyphs. It
          carries no pixels — its whole job is that a drag selects the sentence,
          Cmd-C copies it and the browser's find lands on it, which a canvas
          alone silently refuses. `--total-scale-factor` is the zoom: pdf.js
          writes the runs in page units and multiplies by this, so the layer
          re-scales without being rebuilt. */}
      <div
        ref={textLayerRef}
        data-testid="pdf-text-layer"
        className="pdf-text-layer"
        style={{ ['--total-scale-factor' as string]: scale } as CSSProperties}
      />
      {marks?.map((rect, index) => (
        <span
          // Remounting on each ping is what replays the arrival animation.
          key={`${ping}-${index}`}
          data-testid="passage-mark"
          aria-hidden
          className="passage-highlight animate-passage-ping motion-reduce:animate-none pointer-events-none absolute"
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
    </div>
  )
}

/**
 * What the reader gets when pdf.js cannot run — a blocked worker, a corrupt
 * file, a browser we did not anticipate. The browser's own viewer still renders
 * the document and still honours `#page=N`, so the citation degrades to what it
 * did before this component existed rather than to a blank panel.
 *
 * The notice is shown only when something was actually lost. Opening a file
 * from the Files pane asks for no passage, so telling that reader their passage
 * could not be marked names a failure they did not experience and points at a
 * feature they were not using.
 */
const PdfFallbackFrame: FC<{
  src: string
  title: string
  page?: number | null
  hasPassage: boolean
  className?: string
}> = ({ src, title, page, hasPassage, className }) => {
  const t = useTranslations('knowledge')
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col gap-2', className)}>
      {hasPassage && (
        <p className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="size-3.5" />
          {t('viewer.highlightUnavailable')}
        </p>
      )}
      <iframe
        src={page ? `${src}#page=${page}` : src}
        title={title}
        className="min-h-0 w-full flex-1 rounded-lg border border-border bg-surface-sunken"
      />
    </div>
  )
}
