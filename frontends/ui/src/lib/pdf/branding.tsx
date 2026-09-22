/**
 * The chrome around an exported document: the mark, the cover, the running
 * header and the page footer.
 *
 * ## Why a document needs chrome at all
 *
 * A PDF is the one artefact of this product that is read with the product
 * closed. It gets forwarded to a Behörde, printed into a Befund folder and
 * opened again two years later by somebody who was never a user. Body text
 * alone cannot answer the three questions that reader has — what is this, who
 * made it, and is a page missing — so the chrome answers them on every sheet:
 * the wordmark says what produced it, the title says what it is, and
 * `N / total` says whether the stack is complete.
 *
 * ## Why the mark is redrawn instead of embedded
 *
 * `public/` carries no raster logo, and `components/brand/logo.tsx` is a client
 * component whose `<svg>` is styled with Tailwind and `currentColor` — neither
 * of which exists in react-pdf. So the glyph is redrawn from the same path data
 * with react-pdf's SVG primitives, which keeps it a vector (it stays crisp when
 * the document is printed at any size) and keeps the renderer free of assets it
 * would have to fetch at render time.
 */

import React from 'react'
import { Path, StyleSheet, Svg, View } from '@react-pdf/renderer'

// See printable-text.tsx — the wrapper, not the library's `Text`.
import { Text } from './printable-text'
import { PRODUCT_NAME } from '@/lib/brand'
import { BRAND_MARK, PDF_PAGE, PDF_THEME, PDF_TYPE } from './theme'

/** The document's header facts — the small label/value lines under the title. */
export interface CoverFact {
  label: string
  value: string
  /**
   * Set for a value that is TRANSCRIBED rather than read — a run id, a
   * reference number. The design language's rule ("monospace for identifiers")
   * exists because a proportional font makes `l`/`1` and `O`/`0` the reader's
   * problem at exactly the moment they are copying the thing into a ticket.
   */
  mono?: boolean
}

/**
 * The branded lines a generated document carries, already resolved and already
 * in the reader's language.
 *
 * Structural on purpose: `lib/documents/branding.ts` owns the WORDS and the
 * organization override that can change them, and its `DocumentBranding`
 * satisfies this type without either module importing the other. That keeps the
 * copy out of the renderer — which is the whole point of that module — without
 * making a PDF component depend on the database read that resolves it.
 *
 * Optional as a whole, never in part. A document either carries branding or it
 * does not: a browser export of prose the reader has already read is not a file
 * Piloti filed on somebody's behalf, and stamping it would make the stamp mean
 * nothing (the same argument `MarkdownPdfOptions.marking` makes for the
 * marking).
 */
export interface DocumentChrome {
  /** „Erstellt mit Piloti für …" — printed once, at the top of the cover body. */
  headerLine: string
  /** Two or three sentences: what this is, who drafted it, who carries it. */
  prose: string
  /** One sentence about what the document is not. */
  disclaimer: string
  /** The line that repeats at the foot of every page. */
  footerLine: string
}

export interface CoverInfo {
  /** The document's own name. Never empty: the caller resolves a fallback. */
  title: string
  /** Project, date, and anything else the source of the document stated. */
  facts: CoverFact[]
  /** The branding, when this document is one Piloti produced. */
  chrome?: DocumentChrome
  /**
   * The AI marking, when the document is machine-authored.
   *
   * Above the facts and below the title band, because a reader who stops after
   * the cover has still been told what they are holding — and because the facts
   * are what the document CLAIMS, while this is a statement about how much of
   * it to trust.
   */
  notice?: { title: string; body: string }
}

const styles = StyleSheet.create({
  // ---- the mark ------------------------------------------------------------
  lockup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  wordmark: {
    fontFamily: 'Helvetica',
    fontWeight: 'bold',
    // The app's wordmark is `tracking-tight`; at 8pt on paper the same optical
    // tightness is a touch of negative letter spacing rather than none.
    letterSpacing: -0.2,
  },

  // ---- cover ---------------------------------------------------------------
  coverPage: {
    // No page padding: the ink band is full-bleed, and a band that stops short
    // of the trim reads as a mistake rather than as a design.
    padding: 0,
    fontFamily: 'Helvetica',
    backgroundColor: PDF_THEME.paper,
  },
  band: {
    backgroundColor: PDF_THEME.ink,
    paddingHorizontal: PDF_PAGE.margin,
    paddingTop: 64,
    paddingBottom: 52,
    // A fixed height rather than a hugged one, so a one-line title and a
    // four-line title produce the same cover rather than two different ones.
    height: 320,
    justifyContent: 'space-between',
  },
  coverTitle: {
    color: PDF_THEME.inverse,
    fontWeight: 'bold',
    lineHeight: PDF_TYPE.lineHeightTight,
    letterSpacing: -0.6,
  },
  coverBody: {
    paddingHorizontal: PDF_PAGE.margin,
    paddingTop: 44,
    flexGrow: 1,
  },
  // The marking. A ruled block rather than a filled one: the cover is already
  // the loudest page in the document, and a second filled area competes with
  // the title band instead of being read before the facts.
  coverNotice: {
    borderLeftWidth: 3,
    borderLeftColor: PDF_THEME.ink,
    paddingLeft: 10,
    paddingVertical: 2,
    marginBottom: 28,
  },
  coverNoticeTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  coverNoticeBody: {
    fontSize: 9,
    color: PDF_THEME.subtle,
    lineHeight: 1.45,
  },
  factRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
    paddingVertical: 9,
  },
  factLabel: {
    width: '32%',
    fontSize: PDF_TYPE.meta,
    color: PDF_THEME.subtle,
  },
  factValue: {
    flexGrow: 1,
    fontSize: PDF_TYPE.body,
    color: PDF_THEME.ink,
  },
  factValueMono: {
    fontFamily: 'Courier',
    fontSize: PDF_TYPE.body - 1,
  },
  // The branding header line. Above the marking and the facts, and set in the
  // same subtle chrome type as the running header, because it answers the same
  // question that header answers — what made this, and for whom.
  coverHeaderLine: {
    fontSize: PDF_TYPE.chrome,
    color: PDF_THEME.subtle,
    marginBottom: 22,
  },
  // The prose block. Under the facts rather than over them: the facts say what
  // the document is ABOUT, and this says what the document IS — which is the
  // sentence a reader wants last, on their way to deciding whether to forward
  // it.
  coverProse: {
    marginTop: 26,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: PDF_THEME.hairline,
  },
  coverProseText: {
    fontSize: PDF_TYPE.meta,
    color: PDF_THEME.subtle,
    lineHeight: 1.45,
  },
  coverDisclaimer: {
    fontSize: PDF_TYPE.meta,
    color: PDF_THEME.subtle,
    lineHeight: 1.45,
    marginTop: 6,
  },
  coverFooter: {
    position: 'absolute',
    left: PDF_PAGE.margin,
    right: PDF_PAGE.margin,
    bottom: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  coverRule: {
    flexGrow: 1,
    height: 2,
    marginLeft: 14,
    backgroundColor: PDF_THEME.accent,
  },

  // ---- running header ------------------------------------------------------
  header: {
    position: 'absolute',
    top: PDF_PAGE.headerTop,
    left: PDF_PAGE.margin,
    right: PDF_PAGE.margin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
    paddingBottom: 8,
  },
  headerTitle: {
    fontFamily: 'Helvetica',
    fontSize: PDF_TYPE.chrome,
    color: PDF_THEME.subtle,
    // Bounded so a long title cannot push the wordmark off its own header.
    maxWidth: '62%',
    textAlign: 'right',
  },

  // ---- page footer ---------------------------------------------------------
  footer: {
    position: 'absolute',
    bottom: PDF_PAGE.footerBottom,
    left: PDF_PAGE.margin,
    right: PDF_PAGE.margin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: PDF_THEME.hairline,
    paddingTop: 8,
  },
  footerText: {
    fontFamily: 'Helvetica',
    fontSize: PDF_TYPE.chrome,
    color: PDF_THEME.subtle,
  },
  pageNumber: {
    fontFamily: 'Helvetica',
    fontSize: PDF_TYPE.chrome,
    color: PDF_THEME.subtle,
    fontWeight: 'bold',
  },
})

/** The four-square glyph, at a given edge length and colour. */
export const BrandMark: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <Svg width={size} height={size} viewBox={BRAND_MARK.viewBox}>
    <Path d={BRAND_MARK.path} fill={color} />
  </Svg>
)

/**
 * Mark plus wordmark, the way the app locks them up.
 *
 * The gap is `size / 3.5` rather than a constant because this lockup is drawn
 * at three sizes in one document (cover, header, footer) and a fixed gap that
 * looks right at 26pt looks broken at 9pt.
 */
export const BrandLockup: React.FC<{
  size: number
  color: string
  /** Wordmark size; defaults to the mark's own edge length, which reads level. */
  fontSize?: number
}> = ({ size, color, fontSize }) => (
  <View style={styles.lockup}>
    <BrandMark size={size} color={color} />
    <Text
      style={[
        styles.wordmark,
        { fontSize: fontSize ?? size, color, marginLeft: size / 3.5 },
      ]}
    >
      {PRODUCT_NAME}
    </Text>
  </View>
)

/**
 * The running header. `fixed` so it is drawn once per page by the layout engine
 * rather than once per block by us.
 *
 * The title is repeated here and not only on the cover on purpose: a single
 * sheet pulled out of a folder has to identify itself, and the cover is the one
 * page that never travels with it.
 */
export const RunningHeader: React.FC<{ title: string }> = ({ title }) => (
  <View style={styles.header} fixed>
    <BrandLockup size={9} color={PDF_THEME.ink} />
    <Text style={styles.headerTitle}>{title}</Text>
  </View>
)

/**
 * The page footer: what produced this, and where the reader is in it.
 *
 * The right-hand side is `N / total` rather than a translated "Page N of M".
 * Every other word in an exported document comes out of the dictionary so the
 * file arrives in the language the answer was read in; a numeral needs no
 * dictionary and therefore cannot be the one English string in a German
 * document.
 */
export const PageFooter: React.FC<{ line?: string }> = ({ line }) => (
  <View style={styles.footer} fixed>
    <BrandLockup size={8} color={PDF_THEME.subtle} />
    {/* Between the mark and the numeral, because that is where a reader's eye
        is not: the two ends of a footer are the two things they look for, and
        „Entwurf, nicht freigegeben" is the thing they should meet on the way. */}
    {line ? <Text style={styles.footerText}>{line}</Text> : null}
    <Text
      style={styles.pageNumber}
      render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
    />
  </View>
)

/** Long titles set smaller, so the cover never has to hyphenate a name. */
const coverTitleSize = (title: string): number =>
  title.length > PDF_TYPE.coverTitleBreak ? PDF_TYPE.coverTitleLong : PDF_TYPE.coverTitle

/**
 * The cover's contents.
 *
 * Returned as a fragment rather than as a `Page` so the caller owns the page
 * element — react-pdf resolves `size` and `style` on `Page` only, and a cover
 * that carried its own would silently disagree with the body pages.
 */
export const CoverContent: React.FC<{ cover: CoverInfo }> = ({ cover }) => (
  <>
    <View style={styles.band}>
      <BrandLockup size={26} color={PDF_THEME.inverse} fontSize={22} />
      <Text style={[styles.coverTitle, { fontSize: coverTitleSize(cover.title) }]}>
        {cover.title}
      </Text>
    </View>

    <View style={styles.coverBody}>
      {cover.chrome ? <Text style={styles.coverHeaderLine}>{cover.chrome.headerLine}</Text> : null}
      {cover.notice ? (
        <View style={styles.coverNotice} wrap={false}>
          <Text style={styles.coverNoticeTitle}>{cover.notice.title}</Text>
          <Text style={styles.coverNoticeBody}>{cover.notice.body}</Text>
        </View>
      ) : null}
      {cover.facts.map((fact, index) => (
        <View key={index} style={styles.factRow}>
          <Text style={styles.factLabel}>{fact.label}</Text>
          <Text style={[styles.factValue, ...(fact.mono ? [styles.factValueMono] : [])]}>
            {fact.value}
          </Text>
        </View>
      ))}
      {cover.chrome ? (
        <View style={styles.coverProse} wrap={false}>
          <Text style={styles.coverProseText}>{cover.chrome.prose}</Text>
          <Text style={styles.coverDisclaimer}>{cover.chrome.disclaimer}</Text>
        </View>
      ) : null}
    </View>

    {/* The glyph once more at the foot of the cover, with the accent rule
        running out of it — the one loud gesture on an otherwise quiet page. */}
    <View style={styles.coverFooter}>
      <BrandMark size={12} color={PDF_THEME.ink} />
      <View style={styles.coverRule} />
    </View>
  </>
)

export const COVER_PAGE_STYLE = styles.coverPage
