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
  citedPages,
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
  documentTabLabel,
  splitAnswerBody,
  totalHits,
  unusedDocuments,
  type AnswerBodySplit,
  type BibliographyRow,
} from './views'
