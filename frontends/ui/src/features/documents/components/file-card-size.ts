/**
 * How much room a file surface gives one document.
 *
 * The grid template and the thumbnail well have to agree — a card whose media
 * height was tuned for a 196px cell looks starved in a 240px one — so both
 * numbers live here, in one map, read by {@link FileGrid}, {@link FileCard} and
 * {@link FileCardSkeleton} alike. Changing a column width without its well is
 * then not something you can do by accident.
 *
 * `compact` is the historic metric and stays the default. It is what the chat
 * `document_grid` card needs: that surface sits in a chat column, not a page,
 * and widening its cells there costs it a column.
 *
 * `roomy` is the browsing metric, for the Files browser and the Archiv library.
 * Both now render inside the 1152px content column rather than edge to edge, and
 * a 240px minimum lands four cards per row in it — few enough that the preview
 * is worth looking at, which is the whole reason a plan gets a thumbnail.
 */
export type FileCardSize = 'compact' | 'roomy'

/**
 * `auto-fill` templates: mobile minimum, then the desktop one from `md`.
 *
 * The two sizes are IDENTICAL below `md` on purpose. A phone already shows two
 * cards to a row, which is as few as a grid can be before it is a list, and a
 * wider minimum there buys nothing and costs the second column. What was wrong
 * was the wide window, where 196px laid out six thumbnails the size of stamps.
 */
export const FILE_GRID_TEMPLATE: Record<FileCardSize, string> = {
  compact:
    '[grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] md:[grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]',
  roomy:
    '[grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] md:[grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]',
}

/**
 * The thumbnail well. `min-h` alongside `h` deliberately: the well is a flex
 * child of the card body, and without the floor a long filename could squeeze
 * it — a collapsing thumbnail is a row jump.
 */
export const FILE_CARD_MEDIA: Record<FileCardSize, string> = {
  compact: 'h-[124px] min-h-[124px]',
  roomy: 'h-[124px] min-h-[124px] md:h-[164px] md:min-h-[164px]',
}
