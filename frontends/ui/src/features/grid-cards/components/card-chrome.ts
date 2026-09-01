/**
 * The in-answer card ground — the framed register, understated.
 *
 * "Cards" is the vocabulary of the schema, not of the pixels: the product
 * owner's brief moved from "each card unique and stunning" to "a card should
 * read as part of the answer, never as its own object" (grid-card-charter.md
 * records both). So the framed register stopped being a bordered, shadowed box
 * and became a QUIET GROUND: a soft `bg-muted` tint, no border, no shadow. An
 * exhibit then sits in the answer the way a figure sits in a book — grouped by
 * its ground and its typography, not fenced off from the prose around it.
 *
 * `border-transparent` rather than `border-none`, deliberately: the `Card`
 * atom draws a 1px border, and keeping its width (invisible) means nothing
 * shifts by a pixel — while the accented cards' `border-l-*` colour utilities
 * still take effect on top of it. Order matters for that: pass this constant
 * FIRST into `cn(...)` so a side-specific accent colour wins the merge.
 *
 * One constant, imported by every framed card site (`SchematicCard`, the
 * direct `Card` usages, `ProposalShell`), so "how quiet is a card" is decided
 * exactly once.
 */
export const CARD_SHELL = 'border-transparent bg-muted/40 shadow-none'
