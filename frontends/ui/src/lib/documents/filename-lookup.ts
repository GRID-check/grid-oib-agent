/**
 * Most filenames one by-name lookup carries — shared by the repository that
 * bounds the query and the wire contract that refuses a longer request.
 *
 * A citation, a surfaced-documents card or a search result names a handful;
 * the bound keeps the `IN` list, and the rows it can match, small.
 *
 * No `server-only`: the browser's client batches against it.
 */
export const FILENAME_LOOKUP_MAX_NAMES = 200
