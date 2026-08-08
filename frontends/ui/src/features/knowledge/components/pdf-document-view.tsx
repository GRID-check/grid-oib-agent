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
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { AlertTriangle, Crosshair, Loader2, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { documentParameters, loadPdfjs } from '../lib/pdfjs-runtime'
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
  // Bumped to replay the arrival animation — a CSS animation only runs on
  // mount, so re-pinging means remounting the marks.
  const [ping, setPing] = useState(0)

  const scrollRef = useRef<HTMLDivElement | null>(null)
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

  // A new Fundstelle is a new question. Clearing the old marks stops the
  // previous passage from staying lit on a page the reader has left, and lets
  // the "open at page" fallback run again for the new target.
  useEffect(() => {
    setHit(null)
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
   * Bring a located passage to rest near the top of the frame, and pulse it.
   *
   * Scrolling to the PAGE and scrolling to the PASSAGE are different answers,
   * and only the second is what the click asked for — landing at the top of
   * page 12 when the sentence sits at its foot leaves the reader searching
   * exactly as the old iframe did.
   */
  const revealPassage = useCallback((target: PassageHit) => {
    const frame = scrollRef.current
    const pageNode = pageRefs.current.get(target.page)
    const bounds = passageBounds(target.rects)
    setPing((previous) => previous + 1)
    if (!frame || !pageNode || !bounds) return
    const scale = pageScales.current.get(target.page) ?? 1
    const top = pageNode.offsetTop + bounds.y * scale - frame.clientHeight * PASSAGE_SCROLL_OFFSET
    frame.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [])

  const handlePassage = useCallback(
    (found: PassageHit) => {
      setHit(found)
      revealPassage(found)
    },
    [revealPassage],
  )

  // Opening at a page is the answer when there is no passage to find, and the
  // starting point while the target page's text layer is still being read. A
  // located passage supersedes it.
  useEffect(() => {
    if (!doc || !page || hit) return
    pageRefs.current.get(page)?.scrollIntoView({ block: 'start' })
  }, [doc, page, hit])

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
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          {doc ? t('viewer.pageCount', { count: doc.numPages }) : t('viewer.loading')}
        </span>
        <span className="flex-1" />
        {hit && (
          // After scrolling away — or after a rail jump to another Fundstelle —
          // the way back is one control, not a hunt.
          <button
            type="button"
            onClick={() => revealPassage(hit)}
            className={toolbarButtonClasses}
          >
            <Crosshair aria-hidden className="size-3.5" />
            {t('viewer.toPassage')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setZoomStep((step) => Math.max(0, step - 1))}
          disabled={zoomStep === 0}
          aria-label={t('viewer.zoomOut')}
          className={toolbarIconClasses}
        >
          <Minus aria-hidden className="size-3.5" />
        </button>
        <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoomStep((step) => Math.min(ZOOM_STEPS.length - 1, step + 1))}
          disabled={zoomStep === ZOOM_STEPS.length - 1}
          aria-label={t('viewer.zoomIn')}
          className={toolbarIconClasses}
        >
          <Plus aria-hidden className="size-3.5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        data-testid="pdf-scroll"
        className="min-h-0 w-full flex-1 overflow-auto overscroll-contain rounded-lg border border-border bg-surface-sunken p-3"
      >
        {!doc && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
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
                highlight={number === page ? highlight : null}
                highlightColor={highlightColor}
                marks={hit?.page === number ? hit.rects : null}
                ping={ping}
                onPassage={handlePassage}
                onScale={registerScale}
                registerRef={registerPage}
              />
            ))}
        </div>
      </div>
    </div>
  )
}

const toolbarIconClasses =
  'inline-flex size-6 items-center justify-center rounded-md border border-border text-muted-foreground ' +
  'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40'

const toolbarButtonClasses =
  'inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium ' +
  'text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring/50'

interface PdfPageCanvasProps {
  doc: PDFDocumentProxy
  pageNumber: number
  targetWidth: number
  highlight?: string | null
  highlightColor?: string
  marks: HighlightRect[] | null
  ping: number
  onPassage: (hit: PassageHit) => void
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
  highlight,
  highlightColor,
  marks,
  ping,
  onPassage,
  onScale,
  registerRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [near, setNear] = useState(false)
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

  useEffect(() => {
    const canvas = canvasRef.current
    if (!near || targetWidth <= 0) {
      // Release the bitmap for a page that has scrolled out of the band. The
      // placeholder keeps its height, so nothing moves under the reader.
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      return
    }

    let cancelled = false
    let cancelRender: (() => void) | null = null

    const run = async (): Promise<void> => {
      const pdfPage = await doc.getPage(pageNumber)
      if (cancelled) return
      const base = pdfPage.getViewport({ scale: 1 })
      const pageScale = targetWidth / base.width
      setAspect(base.height / base.width)
      setScale(pageScale)
      onScale(pageNumber, pageScale)

      if (canvas) {
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
      if (cancelled || !highlight) return

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
      if (match) onPassage({ page: pageNumber, rects: match.rects })
    }

    // A page that cannot be drawn must not take the dialog down with it — the
    // other pages, and the document, are still worth reading. The reason still
    // has to be reachable, or "one blank page" is an unfalsifiable bug report.
    void run().catch((error: unknown) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug(`[pdf] page ${pageNumber} failed`, error)
      }
    })
    return () => {
      cancelled = true
      cancelRender?.()
    }
  }, [doc, pageNumber, targetWidth, near, highlight, onPassage, onScale])

  const height = aspect && targetWidth ? targetWidth * aspect : undefined

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
