/**
 * Minimal ambient types for citation-js (the package ships no declarations).
 *
 * Only the surface `citation-export.ts` actually uses is declared, so a typo in
 * a format name is still a type error rather than silently `any`.
 */

declare module '@citation-js/core' {
  export interface CiteFormatOptions {
    format?: 'text' | 'html' | 'string'
    template?: string
    lang?: string
  }

  export class Cite {
    constructor(data: unknown)
    format(format: 'bibtex' | 'biblatex' | 'ris' | 'data', options?: CiteFormatOptions): string
    format(format: 'bibliography' | 'citation', options?: CiteFormatOptions): string
  }
}

declare module '@citation-js/plugin-csl'
declare module '@citation-js/plugin-bibtex'
declare module '@citation-js/plugin-ris'
