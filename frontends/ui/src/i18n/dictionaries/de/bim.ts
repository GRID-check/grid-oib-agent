import type { en } from '../en'

/** IFC/BIM-Oberflächen: Viewer, Modell-Explorer, Viewer-Karte. */
export const bim: typeof en.bim = {
  title: 'Modell',
  tabs: {
    overview: 'Überblick',
    compliance: 'Anforderungen',
    structure: 'Struktur',
    quantities: 'Mengen',
    revisions: 'Revisionen',
  },
  loadFailed: {
    title: 'Modelle konnten nicht geladen werden',
    description:
      'Die Modellliste dieses Projekts ist gerade nicht abrufbar. Das heißt NICHT, dass kein Modell hinterlegt ist — bitte erneut versuchen.',
    action: 'Erneut versuchen',
  },
  empty: {
    title: 'Noch kein IFC-Modell',
    description:
      'Laden Sie unter „Dateien“ eine .ifc-Datei hoch. Piloti liest die Struktur ein, macht das Gebäude im Chat abfragbar und zeigt es hier in 3D.',
    action: 'Zu den Dateien',
  },
  status: {
    pending: 'In Warteschlange',
    extracting: 'Modell wird gelesen…',
    ready: 'Bereit',
    failed: 'Nicht lesbar',
  },
  overview: {
    title: 'Modellübersicht',
    project: 'Projekt',
    site: 'Grundstück',
    building: 'Gebäude',
    schema: 'IFC-Schema',
    author: 'Verfasser',
    exportedWith: 'Exportiert mit',
    exportedAt: 'Exportiert am',
    elements: 'Bauteile',
    spaces: 'Räume',
    storeys: 'Geschoße',
    netFloorArea: 'Netto-Grundfläche',
    grossFloorArea: 'Brutto-Grundfläche',
    netVolume: 'Netto-Rauminhalt',
    lengthUnit: 'Längeneinheit',
    truncated:
      'Dieses Modell hat mehr als {limit} Bauteile. Flächen- und Rauminhaltssummen sind vollständig; Bauteilliste, Modellprüfung und Filter sehen nur diesen Teil.',
  },
  health: {
    title: 'Modellprüfung',
    score: 'Modellqualität {score}/100',
    clean:
      'In diesen Prüfpunkten wurden keine Auffälligkeiten gefunden. Bei den geprüften Bauteilen ist jedes verortet, eindeutig identifiziert und benannt.',
    showElements: 'Bauteile zeigen',
    affected: '{count} von {total}',
    affectedAbsolute: '{count}',
    severity: {
      error: 'Fehler',
      warning: 'Warnung',
      info: 'Hinweis',
    },
    stage: {
      schema: 'Schema',
      identity: 'Identität',
      spatial: 'Räumliche Struktur',
      properties: 'Property Sets',
      complete: 'Vollständigkeit',
    },
    rule: {
      'schema-unknown': 'Die Datei deklariert keine IFC-Schemaversion',
      'schema-legacy': 'IFC2X3 — durch IFC4 abgelöst; manche Merkmale sind nicht abbildbar',
      'identity-missing-globalid': 'Bauteile ohne GlobalId',
      'identity-duplicate-globalid': 'Mehrfach vergebene GlobalIds — Bauteile sind nicht eindeutig',
      'identity-malformed-globalid': 'GlobalIds nicht im 22-stelligen IFC-Format',
      'identity-unreadable-entities':
        'Im Index angeführte, aber nicht definierte Entitäten — sie zählen in keiner Zahl hier mit',
      'spatial-no-storeys': 'Das Modell enthält keine Geschoße',
      'spatial-orphan-elements': 'Bauteile ohne Geschoß — fehlen in jeder geschoßweisen Auswertung',
      'spatial-element-above-storey': 'Bauteile am Grundstück oder Gebäude statt an einem Geschoß',
      'spatial-space-without-storey': 'Räume ohne Geschoßzuordnung',
      'spatial-storey-without-elevation': 'Geschoße ohne Höhenlage',
      'spatial-duplicate-storey-elevation': 'Mehrere Geschoße auf derselben Höhe',
      'properties-no-property-sets': 'Bauteile ganz ohne Property Set',
      'properties-missing-common-pset': 'Bauteile ohne ihr Standard-Property-Set',
      'properties-vendor-sets-only': 'Nur programmspezifische Property Sets — kein Pset_/Qto_',
      'complete-unnamed-elements': 'Bauteile ohne Namen',
      'complete-space-without-area': 'Räume ohne Flächenangabe — Flächensummen sind unvollständig',
      'complete-no-quantities': 'Kein Bauteil führt Mengen',
      'complete-no-materials': 'Tragende Bauteile ohne Material',
      'complete-no-classifications': 'Kein Bauteil trägt eine Klassifikation',
    },
  },
  tree: {
    title: 'Räumliche Struktur',
    allStoreys: 'Alle Geschoße',
  },
  elements: {
    title: 'Bauteile',
    search: 'Nach Name, Kennzeichen oder GlobalId suchen…',
    allTypes: 'Alle Typen',
    columns: {
      type: 'Typ',
      name: 'Name',
      storey: 'Geschoß',
    },
    empty: 'Kein Bauteil entspricht diesem Filter.',
    count: '{shown} von {total} Treffern',
    countOne: '{shown} von {total} Treffer',
    unnamed: '(ohne Namen)',
  },
  properties: {
    none: 'Wählen Sie ein Bauteil, um seine Eigenschaften zu sehen.',
    identity: 'Identität',
    globalId: 'GlobalId',
    ifcType: 'IFC-Typ',
    predefinedType: 'Vordefinierter Typ',
    typeName: 'Bauteiltyp',
    tag: 'Kennzeichen',
    storey: 'Geschoß',
    materials: 'Materialien',
    classifications: 'Klassifikationen',
    loadFailed: 'Das Bauteil konnte nicht geladen werden.',
  },
  compare: {
    title: 'Revisionen vergleichen',
    description:
      'Abgeglichen über die IFC-GlobalId: Ein Re-Export, bei dem sich nur die internen Nummern der Datei ändern, meldet daher keine Änderung.',
    against: 'Vergleichen mit',
    ranAgainst: 'Verglichen mit {model}',
    sameRevision: 'Beide Namen bezeichnen dieselbe Revision — es gibt nichts zu vergleichen.',
    none: 'Laden Sie eine zweite Revision hoch, um zu vergleichen.',
    run: 'Vergleichen',
    running: 'Wird verglichen…',
    failed: 'Der Bauteilvergleich konnte nicht durchgeführt werden.',
    added: 'Neu',
    removed: 'Entfallen',
    changed: 'Geändert',
    unchanged: 'Unverändert',
    more: '… {count} weitere Bauteile',
    moreOne: '… ein weiteres Bauteil',
    truncated:
      'Mindestens eine Revision wurde nur teilweise eingelesen — der Vergleich kann unvollständig sein.',
    empty: 'Keine Unterschiede zwischen diesen beiden Revisionen.',
  },
  compliance: {
    title: 'Anforderungsprüfung',
    description:
      'Prüft die im Modell hinterlegten Werte gegen den OIB-Regelkatalog. Orientierung, kein Nachweis: es wird keine Geometrie ausgewertet — Fluchtweglängen, Geländerhöhen und Brandabschnittsgrößen werden daher gar nicht geprüft.',
    failed: 'Die Anforderungsprüfung konnte nicht durchgeführt werden.',
    truncatedModel:
      'Dieses Modell ist zu groß, um vollständig geprüft zu werden — der Katalog hat nur einen Teil gesehen. Alle Zahlen unten beziehen sich auf diesen Teil, nicht auf das Gebäude.',
    disclaimer:
      'Orientierende Prüfung — keine Rechtsauskunft und kein Nachweis. „Nicht entscheidbar“ heißt: das Modell führt den Wert nicht, nicht dass das Gebäude die Anforderung verfehlt.',
    counts: '{passed} erfüllt · {failed} nicht erfüllt · {undecidable} nicht entscheidbar',
    notApplicable: 'Nicht einschlägig',
    noElements: 'Keine betroffenen Bauteile in diesem Modell.',
    failures: 'Nicht erfüllt:',
    unknowns: 'Nicht entscheidbar:',
    showInModel: 'im Modell zeigen',
    more: '{count} weitere Bauteile',
    moreOne: 'Ein weiteres Bauteil',
    truncated: 'Weitere Bauteile betroffen — siehe Anzahl oben.',
    missingFacts:
      'Einige Regeln hängen an Angaben, die das Projekt-Briefing nicht führt: {facts}. Diese Regeln wurden nicht angewendet, statt zu raten.',
    setFacts: 'Über den Assistenten ergänzen',
    factName: {
      gebaeudeklasse: 'Gebäudeklasse',
      hauptnutzung: 'Hauptnutzung',
    },
    factsFailed:
      'Das Projekt-Briefing konnte nicht gelesen werden — die davon abhängigen Regeln wurden daher nicht angewendet. Über das Briefing selbst sagt das nichts aus.',
    badge: {
      passing: 'Erfüllt',
      failing: 'Nicht erfüllt',
      undecidable: 'Nicht entscheidbar',
      notApplicable: 'Nicht einschlägig',
      noElements: 'Keine Bauteile',
    },
    confirmed: {
      by: 'Bestätigt von {who} am {when}',
      stale: 'Ältere Revision',
      staleHint:
        'Diese Bestätigung wurde gegen eine frühere Revision des Modells abgegeben. Sie bleibt als Eintrag erhalten, gilt aber nicht für die aktuelle Revision.',
      failed: 'Die Bestätigung konnte nicht gespeichert werden. Sie ist NICHT hinterlegt — bitte erneut versuchen.',
      readFailed:
        'Die zu diesem Projekt erfassten Bestätigungen konnten nicht gelesen werden — vorhandene werden hier daher nicht angezeigt. Eine Anforderung unten kann bereits bestätigt sein.',
      denied:
        'Sie haben Lesezugriff auf dieses Projekt — Bestätigungen werden angezeigt, können aber nicht hinterlegt oder zurückgezogen werden. Jemand mit Bearbeitungsrecht kann das eintragen.',
      confirm: 'Manuell bestätigen',
      reconfirm: 'Für diese Revision erneut bestätigen',
      withdraw: 'Zurückziehen',
      withdrawConfirm: 'Diese Bestätigung samt Notiz löschen?',
      save: 'Bestätigung speichern',
      cancel: 'Abbrechen',
      noteLabel: 'Warum das geklärt ist',
      notePlaceholder: 'z. B. anhand des Plans geprüft, mit dem Brandschutzplaner abgestimmt …',
    },
    card: {
      export: 'Offene Punkte als BCF',
      unresolved: '{count} der angeforderten Regeln sind nicht im Katalog.',
      unresolvedOne: 'Eine der angeforderten Regeln ist nicht im Katalog.',
      none: 'Keine der angeforderten Anforderungen ist im Katalog.',
    },
    shoppingList: {
      title: 'Was dem Modell fehlt',
      description:
        'Ergänzen Sie diese Werte im CAD, dann werden die Anforderungen oben entscheidbar. Das ist die Liste, keine Note.',
      count: 'an {count} Bauteilen',
      countOne: 'an einem Bauteil',
    },
    export: {
      action: '{count} offene Punkte als BCF',
      actionOne: 'Ein offener Punkt als BCF',
      hint: 'BCF 2.1 — öffnet in ArchiCAD, Revit, Solibri oder BIMcollab als Aufgabenliste und markiert die betroffenen Bauteile im Modell. Bereits bestätigte Anforderungen sind darin als erledigt markiert.',
    },
  },
  complianceDiff: {
    title: 'Was diese Revision verändert hat',
    description:
      'Führt die Anforderungsprüfung auf beiden Revisionen aus und listet nur, was sich geändert hat — gegenüber {previous}.',
    run: 'Anforderungsstatus vergleichen',
    running: 'Wird verglichen…',
    failed: 'Der Statusvergleich konnte nicht durchgeführt werden.',
    unchanged: 'Keine Anforderung hat ihren Status zwischen diesen beiden Revisionen geändert.',
    truncated:
      'Mindestens eine Revision wurde nur teilweise eingelesen — dieser Vergleich deckt jeweils nur einen Teil des Gebäudes ab. „Unverändert“ heißt hier nicht, dass sich nichts geändert hat.',
    counts:
      '{beforePassed}/{beforeFailed}/{beforeUndecidable} → {afterPassed}/{afterFailed}/{afterUndecidable} erfüllt/nicht erfüllt/nicht entscheidbar',
    trend: {
      broken: 'neu nicht erfüllt',
      undecidable: 'nicht mehr entscheidbar (Wert im Modell entfallen)',
      moved: 'weiterhin nicht erfüllt, andere Anzahl',
      decidable: 'jetzt entscheidbar und erfüllt',
      resolved: 'jetzt erfüllt',
    },
  },
  schedule: {
    storeyElided: '{count} weitere Räume in diesem Geschoß',
    storeyElidedOne: 'Ein weiterer Raum in diesem Geschoß',
    truncated:
      'Dieses Modell wurde nur teilweise eingelesen — die Summen unten beziehen sich auf die gespeicherten Räume, nicht auf das Gebäude.',
    title: 'Raumbuch',
    download: 'CSV',
    room: 'Raum',
    netArea: 'Netto-Grundfläche',
    volume: 'Netto-Rauminhalt',
    storeyTotal: 'Summe Geschoß',
    total: 'Gesamt',
    missing: 'Räume ohne Flächenangabe: {count} — in diesen Summen nicht enthalten.',
    storeyMissing: '{count} ohne Fläche',
    expand: 'Weitere {count} Räume anzeigen',
    expandOne: 'Einen weiteren Raum anzeigen',
    collapse: 'Weniger anzeigen',
    empty: 'Dieses Modell enthält keine Räume (IfcSpace).',
    storeyEmpty: 'Dieses Modell hat kein Geschoß mit dem Namen „{storey}“.',
    failed: 'Das Raumbuch konnte nicht geladen werden.',
  },
  takeoff: {
    showAll: 'Weitere {count} Gruppen anzeigen',
    showAllOne: 'Eine weitere Gruppe anzeigen',
    truncated:
      'Dieses Modell wurde nur teilweise eingelesen — die Summen unten beziehen sich auf die gespeicherten Bauteile, nicht auf das Gebäude.',
    collapse: 'Weniger anzeigen',
    title: 'Massenermittlung',
    description:
      'Summiert die im Modell veröffentlichten Mengen je Bauteiltyp. Bauteile ohne Wert werden getrennt ausgewiesen — eine Summe über einen unvollständigen Satz ist keine Summe.',
    quantity: 'Menge',
    byMaterial: 'Nach Material trennen',
    group: 'Typ',
    quantityName: {
      NetSideArea: 'Netto-Seitenfläche',
      GrossSideArea: 'Brutto-Seitenfläche',
      NetVolume: 'Netto-Rauminhalt',
      GrossVolume: 'Brutto-Rauminhalt',
      NetFloorArea: 'Netto-Grundfläche',
      GrossFloorArea: 'Brutto-Grundfläche',
      Length: 'Länge',
      Width: 'Breite',
      Height: 'Höhe',
    },
    elements: 'Bauteile',
    missing: 'Bauteile ohne Wert für diese Menge: {count}.',
    rowMissing: '({count} ohne Wert)',
    empty: 'Kein Bauteil führt diese Menge.',
    failed: 'Die Massenermittlung konnte nicht berechnet werden.',
  },
  profile: {
    title: 'Projektangaben aus dem Modell',
    description:
      'Abgeleitet aus den Höhenlagen der Geschoße und der Raumnutzung. Vorschläge, keine Messwerte — die Übernahme in das Projekt-Briefing bestätigen Sie im Chat.',
    ask: 'Über den Assistenten übernehmen',
    empty: 'Aus diesem Modell lassen sich keine Projektangaben ableiten.',
    failed: 'Die Projektangaben konnten nicht abgeleitet werden.',
    key: {
      geschosse_oberirdisch: 'Oberirdische Geschoße',
      geschosse_unterirdisch: 'Unterirdische Geschoße',
      fluchtniveau: 'Fluchtniveau',
      hauptnutzung: 'Hauptnutzung',
      anzahl_einheiten: 'Nutzungseinheiten',
    },
    confidence: {
      high: 'Hohe Verlässlichkeit',
      medium: 'Mittlere Verlässlichkeit',
      low: 'Geringe Verlässlichkeit',
    },
  },
  timeline: {
    title: 'Revisionen',
    description: '{count} Revisionen von {name}, neueste zuerst.',
    revision: 'Revision {index}',
    latest: 'Aktuell',
    compare: 'Mit {previous} vergleichen',
    noDelta: 'Für diese Revision liegen keine vergleichbaren Kennzahlen vor.',
    delta: {
      elements: 'Bauteile',
      spaces: 'Räume',
      storeys: 'Geschoße',
      netFloorArea: 'Netto-Grundfläche',
      health: 'Modellqualität',
    },
  },
  element: {
    notFound: 'Dieses Bauteil ist im Modell nicht enthalten.',
  },
  link: {
    copy: 'Link zur Ansicht kopieren',
    copied: 'Link kopiert',
    failed: 'Der Link konnte nicht kopiert werden',
  },
  stage: {
    dialogLabel: 'Modell {name}',
    fileActions: 'Dateiaktionen',
    close: 'Schließen',
    home: 'Ganzes Modell einpassen',
    back: 'Letzte Änderung rückgängig machen',
    views: 'Ansicht',
    advanced: 'Details & Prüfung',
    models: 'Modelle',
    levels: 'Geschoße',
    allLevels: 'Alle Geschoße',
    highlightCapped:
      'Ein Link kann {shown} der {total} hervorgehobenen Bauteile mitführen. Die übrigen sind im Modell, hier aber nicht markiert.',
    otherModel:
      'Dieser Link nennt „{wanted}“ — dieses Modell gibt es in diesem Projekt nicht. Angezeigt wird „{opened}“.',
    showEverything: 'Alle Bauteile wieder einblenden',
    elevation: '{value} m',
    notReady: 'Das Modell wird noch gelesen. Das dauert meist nur einen Moment.',
    elementsFailed:
      'Die Bauteilliste konnte nicht geladen werden — im Modell lässt sich daher nichts auswählen oder filtern. Am Gebäude selbst liegt es nicht.',
    readFailed:
      'Diese Datei konnte nicht eingelesen werden. Bitte exportieren Sie sie erneut aus Ihrem CAD und laden Sie sie noch einmal hoch.',
    loading: 'Modell wird geladen…',
    building: 'Gebäude wird aufgebaut…',
    ready: 'Das Modell ist da',
    rail: {
      show: 'Leiste einblenden',
      hide: 'Leiste ausblenden',
    },
    selection: {
      close: 'Schließen',
      loading: 'Wird geladen…',
      about: 'Bauteil',
      hide: 'Ausblenden',
      isolate: 'Isolieren',
      technical: 'Technische Details',
      ask: 'Piloti dazu fragen',
    },
  },
  viewer: {
    canvasLabel: '3D-Ansicht des IFC-Modells',
    keyboardHint:
      'Pfeiltasten drehen, Umschalt mit Pfeiltaste verschiebt, Plus und Minus zoomen, F passt das Modell ein. Beim Messen setzt Eingabe einen Punkt, Esc bricht ab. Alle Bauteile stehen zusätzlich als Liste unter „Details“.',
    xray: 'Durchsichtig',
    xrayNeedsTarget: 'Durchsichtig — zuerst ein Bauteil auswählen oder eine markierte Antwort öffnen',
    view: {
      iso: 'Frei',
      top: 'Grundriss',
      north: 'Nord',
      south: 'Süd',
      east: 'Ost',
      west: 'West',
    },
    projection: {
      parallel: 'Parallel',
    },
    /** Die Ansicht als Bild sichern. */
    capture: {
      action: 'Bild speichern',
      failed: 'Das Bild konnte nicht erstellt werden',
    },
    section: {
      toggle: 'Schnitt',
      height: 'Schnitthöhe',
      metres: '{value} m',
      down: 'Blick nach unten',
      up: 'Blick nach oben',
    },
    /**
     * Messen. `hint` steht im Dock, solange das Werkzeug aktiv ist — ein
     * Messwerkzeug ohne Ansage, wohin der nächste Klick gehört, ist ein
     * Fadenkreuz, mit dem man erst einmal experimentieren muss.
     */
    measure: {
      toggle: 'Messen',
      horizontal: 'horizontal',
      vertical: 'vertikal',
      first: 'Ersten Punkt anklicken',
      second: 'Zweiten Punkt anklicken — Esc bricht ab',
      clear: 'Messungen löschen',
      count: '{count} Messungen',
      countOne: '1 Messung',
    },
    unavailable: {
      title: 'Die 3D-Ansicht konnte nicht geladen werden',
      description:
        'Es fehlt nur das Bild — das Modell selbst ist davon nicht betroffen, alles daraus Gelesene bleibt unverändert. Ein Browser mit gesperrter GPU, eine Remote-Desktop-Sitzung oder ein abgebrochener Download sind die üblichen Ursachen.',
      reason: 'Ursache: {message}',
    },
    unsupported: {
      title: '3D-Ansicht in diesem Browser nicht verfügbar',
      description:
        'Die 3D-Ansicht benötigt WebGPU, das dieser Browser nicht bereitstellt. Am Modell selbst liegt es nicht — Piloti beantwortet weiterhin Fragen dazu, und in Chrome, Edge oder einem aktuellen Safari wird das Modell angezeigt.',
    },
  },
  facts: {
    title: 'Aus dem Modell',
    caption:
      'Beim Einlesen direkt aus der IFC-Datei übernommen. Eine Menge, die die Datei nicht führt, fehlt hier — sie wird nicht als Null angezeigt.',
  },
  preview: {
    loading: 'Modell wird geladen…',
    extracting:
      'Piloti liest dieses Modell gerade ein. Sobald das abgeschlossen ist, erscheint das Gebäude hier.',
    extractionFailed:
      'Dieses Modell konnte nicht eingelesen werden. Die Datei selbst ist unverändert und kann weiterhin heruntergeladen werden.',
    noModel: 'Zu dieser Datei wurde kein Modell eingelesen.',
    loadFailed:
      'Die Modelle dieses Projekts sind gerade nicht abrufbar. Das heißt NICHT, dass zu dieser Datei kein Modell vorliegt.',
    sourceFailed:
      'Die 3D-Vorschau konnte nicht geladen werden. Das Modell selbst ist eingelesen — Struktur, Bauteile und Mengen stehen im Modellbereich zur Verfügung.',
    noWebGpu:
      'Die 3D-Ansicht benötigt WebGPU, das dieser Browser nicht bereitstellt. Alles, was aus dem Modell gelesen wurde — Struktur, Bauteile, Eigenschaften und Mengen — steht im Modellbereich zur Verfügung.',
    open: 'Im Modellbereich öffnen',
  },
  card: {
    openModel: 'Modell öffnen',
    openElement: 'Im Modell öffnen',
    openStorey: 'Geschoß {name} im Modell öffnen',
    unresolved: '{count} der hervorgehobenen Bauteile sind in diesem Modell nicht enthalten.',
    unresolvedOne: 'Eines der hervorgehobenen Bauteile ist in diesem Modell nicht enthalten.',
    highlightsFailed:
      'Die hervorgehobene Auswahl konnte nicht ermittelt werden — hier ist daher nichts markiert. Das ist kein Ergebnis über das Gebäude.',
    noModel: 'Das referenzierte Modell ist in diesem Projekt nicht verfügbar.',
    ambiguousModel:
      'Auf diesen Namen passen mehrere Modelle in diesem Projekt — welches Gebäude gemeint ist, lässt sich hier nicht sagen.',
  },
  modelPicker: {
    failed: 'Die Modelle dieses Projekts konnten nicht geladen werden.',
    openAria: '{name} im Modellbereich öffnen',
  },
}
