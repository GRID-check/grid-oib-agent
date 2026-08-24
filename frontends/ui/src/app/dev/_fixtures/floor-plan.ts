/**
 * A drawing for the `/dev` previews, as a data URI.
 *
 * The file peek exists to hold a PLAN beside a conversation, and every preview
 * of it was reviewed against a grey "Vorschau konnte nicht geladen werden" box:
 * `/dev` has no backend, so the preview endpoint 403s and the pane falls back to
 * its failure state. Judging the pane's seams, its ground, its shadow and its
 * behaviour at width against an error message is judging the wrong thing.
 *
 * SVG rather than bytes on disk: it renders identically in every browser and at
 * every width (the peek runs from 280px to 960px), it costs no fixture file, and
 * a vector plan is what an architect's drawing actually is.
 */

const PLAN = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 500" width="595" height="500">
  <rect width="595" height="500" fill="#ffffff"/>
  <g stroke="#1e1e1e" fill="none" stroke-linecap="square">
    <rect x="64" y="96" width="467" height="300" stroke-width="6"/>
    <path d="M64 246h180M244 96v150M244 316h287M380 246v150" stroke-width="6"/>
    <path d="M120 96v0M120 93h56" stroke-width="10" stroke="#ffffff"/>
    <path d="M148 96a28 28 0 0 1 28 28" stroke-width="1.5" stroke-dasharray="4 4"/>
    <path d="M244 200a28 28 0 0 0-28 28" stroke-width="1.5" stroke-dasharray="4 4"/>
    <path d="M64 430h467" stroke-width="1"/>
  </g>
  <g fill="#1e1e1e" font-family="Helvetica, Arial, sans-serif">
    <text x="64" y="72" font-size="19" font-weight="bold">Grundriss Erdgeschoss</text>
    <text x="64" y="88" font-size="11" fill="#6b6b6b">M 1:100 &#183; Baufeld D12 &#183; Stand 04/2026</text>
    <text x="96" y="180" font-size="12">Foyer</text>
    <text x="96" y="196" font-size="10" fill="#6b6b6b">42,10 m&#178;</text>
    <text x="290" y="180" font-size="12">B&#252;ro 01</text>
    <text x="290" y="196" font-size="10" fill="#6b6b6b">28,40 m&#178;</text>
    <text x="96" y="330" font-size="12">Technik</text>
    <text x="96" y="346" font-size="10" fill="#6b6b6b">18,75 m&#178;</text>
    <text x="410" y="360" font-size="12">Lager</text>
    <text x="410" y="376" font-size="10" fill="#6b6b6b">21,00 m&#178;</text>
    <text x="64" y="458" font-size="11" fill="#6b6b6b">Fluchtwege rot strichliert &#183; Feuerwiderstand tragender W&#228;nde REI 90</text>
    <text x="64" y="478" font-size="11" fill="#6b6b6b">Zwei voneinander unabh&#228;ngige Fluchtwege je Nutzungseinheit.</text>
  </g>
  <g stroke="#c92a2a" stroke-width="2" stroke-dasharray="8 5" fill="none">
    <path d="M150 246L150 366L64 366"/>
    <path d="M300 246L460 246L460 120"/>
  </g>
  <g fill="#c92a2a" font-family="Helvetica, Arial, sans-serif">
    <text x="158" y="362" font-size="10">Fluchtweg 1</text>
    <text x="404" y="140" font-size="10">Fluchtweg 2</text>
  </g>
</svg>`

/** The plan as a `data:` URI, ready for an `<img src>`. */
export const FLOOR_PLAN_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(PLAN.trim())}`
