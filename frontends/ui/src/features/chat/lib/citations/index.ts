/**
 * The citation feature's public surface.
 *
 * Import from here, never from the individual modules — the split inside is an
 * implementation detail (model / locator / build / target / views) and the
 * point of this barrel is that a consumer sees ONE vocabulary:
 *
 *   buildCitationModel(inputs) → CitedDocument[] → a projection → render
 *
 * If a surface needs a fact that is not on `CitedDocument`, the fix is to carry
 * it on the model, not to parse it again downstream. That rule is the entire
 * difference between this and what it replaced.
 */

export {
  CitationAccumulator,
  citationNumbers,
  citedLoci,
  // The two specific claims, exported deliberately: `documentPages` is what a
  // SURFACE prints, and these are what it is made of. Kept nameable so a caller
  // that means "cited" or "read" can say so rather than reaching for the
  // display rule and then explaining why.
  citedPages,
  documentPages,
  readPages,
  compareDocuments,
  documentIdentity,
  hitCount,
  hostnameOf,
  identityMatches,
  isCited,
  isHttpUrl,
  locusKey,
  locusOf,
  normalizeUrl,
  refHost,
  refKey,
  refNumber,
  refPage,
  refPages,
  oibDocumentKey,
  resolveKind,
  resolveTint,
  resolveTitle,
  stripOriginToken,
  type CitationLocus,
  type CitationOrigin,
  type CitationRef,
  type CitedDocument,
  type DocumentIdentityInput,
} from './model'

export { parseKbLocator, locatorFromPseudoUrl, type KbCitationLocator } from './locator'

export {
  CITATION_PARAM,
  citationShareUrl,
  encodeCitationLink,
  parseCitationLink,
  resolveCitationLink,
  type CitationLink,
} from './deep-link'

export {
  CITATIONS_PAYLOAD_VERSION,
  decodeCitations,
  encodeCitations,
  type PersistedCitations,
} from './persistence'

export { buildCitationModel, citationSnippet, type CitationInputs } from './build'

export {
  openAtLocus,
  resolveCitationTarget,
  type CitationTarget,
  type StoredDocumentRef,
} from './target'

export {
  ANSWER_SOURCE_ANCHOR_PREFIX,
  anchoredNumbers,
  answerDocuments,
  answerSourceAnchorPrefix,
  bibliographyRows,
  documentShelfLabel,
  documentTabLabel,
  referencesByNumber,
  splitAnswerBody,
  totalHits,
  unusedDocuments,
  type AnswerBodySplit,
  type BibliographyRow,
} from './views'
