/**
 * Single source of truth for the user-facing product brand.
 *
 * Decision (2026-07-17, click-dummy-overhaul-spec §8): the product ships
 * user-facing as **Piloti**. The internal / repo / platform name stays
 * **GRID** — env vars (`GRID_*`), headers (`x-grid-*`), CSS variables,
 * localStorage keys, DB identifiers and the "GRID Platform" organization are
 * NOT renamed. Use this constant for every user-visible brand mention
 * (wordmark, tab titles, aria labels); never for internal identifiers.
 */
export const PRODUCT_NAME = 'Piloti'
