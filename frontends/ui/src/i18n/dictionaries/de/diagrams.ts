import type { en } from '../en'

/**
 * `diagrams` — siehe die englische Quelle für die Begründung.
 *
 * „Schematisch" statt „Skizze": eine Skizze ist eine Zeichnung, die noch nicht
 * fertig ist; schematisch heißt, dass die Darstellung bewusst keine Maße
 * behauptet. Das ist hier der ganze Punkt und der Unterschied zu den fünfzehn
 * Schemakarten, deren Geometrie gerechnet wird.
 */
export const diagrams: typeof en.diagrams = {
  schematicOnly: 'Schematisch — ohne Maßangabe.',
  /** The file name a diagram gets when neither the source nor the surface names it. */
  defaultTitle: 'Diagramm',
  fallback: 'Dieses Diagramm konnte nicht gezeichnet werden. Der Quelltext steht unten.',
  file: {
    action: 'Im Projekt ablegen',
    pending: 'Wird abgelegt …',
    done: 'Im Projekt abgelegt',
    open: 'Im Projekt öffnen',
    failed: 'Konnte nicht abgelegt werden',
    partial: 'Das Bild wurde abgelegt, das PDF nicht. Nochmals versuchen, um es zu ergänzen.',
  },
  marking:
    'Von Piloti erstellt — KI-generiert, nicht geprüft. Schematisch: ohne Maßangabe. Kein Nachweis; prüfen Sie jede Angabe, bevor Sie das Dokument weitergeben.',
  rejected: {
    empty: 'Das Diagramm war leer.',
    'too-large': 'Das Diagramm ist zu groß, um abgelegt zu werden.',
    'malformed-xml': 'Das Diagramm ist kein wohlgeformtes XML.',
    'doctype-or-entity': 'Das Diagramm deklariert einen Dokumenttyp oder eine Entität. Das ist nicht zulässig.',
    'not-svg': 'Die Datei ist kein SVG.',
    'missing-viewport': 'Das Diagramm nennt keine Größe und lässt sich deshalb nicht auf eine Seite setzen.',
    'script-element': 'Das Diagramm enthält ein Skript.',
    'foreign-object': 'Das Diagramm bettet HTML ein (foreignObject). Bitte mit abgeschaltetem htmlLabels zeichnen.',
    'style-element':
      'Das Diagramm bringt ein Stylesheet mit. Die Stile müssen vor dem Ablegen auf die Elemente übertragen werden.',
    'unsupported-element': 'Das Diagramm verwendet ein Element, das dieses Produkt nicht zeichnet.',
    'event-handler-attribute': 'Das Diagramm enthält einen Ereignis-Handler.',
    'external-reference': 'Das Diagramm verweist auf etwas außerhalb seiner selbst.',
    'source-too-large': 'Der Quelltext des Diagramms ist zu lang.',
  },
}
