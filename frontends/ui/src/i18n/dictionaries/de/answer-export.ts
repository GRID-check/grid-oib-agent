import type { en } from '../en'

/**
 * `answerExport` namespace — siehe die englische Quelle für die Begründung.
 *
 * Der Wortschatz folgt dem, was die App im Gespräch schon sagt (`chat.cards.*`):
 * „Zuständig“, „Voraussetzungen“, „Fristbeginn“, „Wenn versäumt“, „Grenzwert“,
 * „Bisher“/„Dann“ stehen dort bereits an denselben Feldern. Ein Dokument, das
 * dieselbe Sache anders benennt als der Bildschirm, auf dem sie entstanden ist,
 * zwingt die Leserin, beides zu übersetzen.
 *
 * `label-coverage.spec.ts` leitet aus `shared/cards/schemas.json` ab, welche
 * Feldnamen der Export überhaupt beschriften kann, und schlägt fehl, sobald
 * einer davon hier fehlt — ein fehlender Schlüssel wird sonst zu einem
 * englischen Wort im deutschen Befund. Dasselbe gilt für `values`: jedes
 * Mitglied jedes `Literal` aus `models.py` braucht hier ein Wort, sonst stünde
 * `Wirkung | tightens` in einem deutschen Bauakt.
 */
export const answerExport: typeof en.answerExport = {
  documentTitle: 'Antwort',
  fileName: 'antwort',
  aiNotice: {
    title: 'KI-generiert — nicht geprüft',
    body: 'Dieses Dokument hat Piloti erstellt; ein Mensch hat es nicht geprüft. Es ist ein Entwurf und kein Nachweis — prüfen Sie jede Angabe, bevor Sie das Dokument weitergeben oder einreichen.',
  },
  // Siehe die englische Quelle für die drei Bedingungen an diesen Satz: wahr
  // zum Satzzeitpunkt, kein Fehler und keine Entschuldigung. „nicht
  // dargestellt" beschreibt die Datei; „konnte nicht" beschriebe die Arbeit.
  diagramPlaceholder:
    'Diagramm — in dieser Datei nicht dargestellt. Die Antwort in Piloti zeigt es als Grafik.',
  question: 'Frage',
  answer: 'Antwort',
  project: 'Projekt',
  createdAt: 'Erstellt am',
  sources: 'Quellen',
  findings: 'Befunde',
  findingsMatrix: {
    title: 'Befundmatrix',
    requirement: 'Anforderung',
    value: 'Wert',
    reference: 'Fundstelle',
    status: {
      label: 'Status',
      erfuellt: 'erfüllt',
      nicht_erfuellt: 'nicht erfüllt',
      offen: 'offen',
      nicht_anwendbar: 'nicht anwendbar',
    },
    grounding: { belegt: 'belegt', abgeleitet: 'abgeleitet', offen: 'ohne Beleg' },
  },
  legalBasis: 'Rechtsgrundlagen',
  // Beschriftungen eines Deckblatts, keine Sätze: „Standort“ und „Erstellt
  // von“ stehen links in einer zweispaltigen Aufstellung, so wie es eine
  // Amtsleserin auf dem Ausdruck erwartet. „Bundesland“ und „Analyse-ID“
  // bleiben in beiden Sprachfassungen bei ihrem jeweiligen Fachwort — die
  // englische Fassung folgt hier `platform`, das den Begriff dort schon
  // beschriftet.
  reportCover: {
    location: 'Standort',
    bundesland: 'Bundesland',
    author: 'Erstellt von',
    analysisId: 'Analyse-ID',
  },
  confidence: 'Verlässlichkeit',
  confidenceReason: 'Begründung des Assistenten',
  confidenceLevels: {
    low: 'niedrig',
    medium: 'mittel',
    high: 'hoch',
  },
  confidenceCapped: {
    ungrounded: 'Begrenzt: die Antwort ist nicht durch Quellen belegt.',
    quoteUnverified: 'Begrenzt: ein Zitat war nicht wortgleich gegen die Quelle prüfbar.',
  },
  page: 'S. {page}',
  untitledSource: 'Quelle ohne Titel',
  liveCard:
    'Diese Karte liest das Modell des Projekts live — ein Dokument kann die gezeigten Werte nicht mitführen. Öffnen Sie die Antwort in Piloti, um sie zu sehen.',
  cardTypes: {
    project_profile_patch: 'Vorgeschlagene Änderung am Projektkontext',
    memory_proposal: 'Vorgeschlagener Merkposten',
    building_section: 'Gebäudeschnitt',
    stair_diagram: 'Treppe',
    dimension_diagram: 'Maße',
    setback_plan: 'Abstandsflächen',
    egress_diagram: 'Fluchtweg',
    daylight_incidence: 'Belichtung',
    guardrail_check: 'Absturzsicherung',
    fire_access_plan: 'Feuerwehrzufahrt',
    document_grid: 'Dokumente',
    calculation: 'Rechenweg',
    surface: 'Zusammenstellung',
    ifc_viewer: 'Modellansicht',
    ifc_compliance: 'Modellprüfung',
    ifc_schedule: 'Raumbuch',
    ifc_element: 'Modellelement',
    ifc_diff: 'Modelländerungen',
  },
  values: {
    status: {
      pass: 'Anforderung erfüllt',
      fail: 'Anforderung nicht erfüllt',
      warning: 'Zu prüfen',
      needs_input: 'Angabe erforderlich',
    },
    provenance: {
      declared: 'laut Modell',
      computed: 'gemessen',
      inferred: 'vermutlich',
    },
    // Ausgeschrieben nur dort, wo der Vergleich allein in einer Zeile steht.
    // Neben einer Zahl bleibt das Zeichen stehen: „<= 18 cm“ liest sich als
    // eine Größe, „höchstens 18 cm“ als ein Satz in einer Tabellenzelle.
    comparator: {
      '<=': 'höchstens',
      '>=': 'mindestens',
      between: 'zwischen',
    },
    context: {
      balkon: 'Balkon',
      loggia: 'Loggia',
      stiege: 'Stiege',
      fenster: 'Fenster',
      dachterrasse: 'Dachterrasse',
    },
    // `building_section.markers.kind`: the role of a section marker.
    kind: {
      fluchtniveau: 'Fluchtniveau',
      threshold: 'Schwellenwert',
      reference: 'Bezugslinie',
    },
    operation: {
      sum: 'Summe',
      product: 'Produkt',
      quotient: 'Quotient',
      percent_of: 'Prozent von',
      percent_ratio: 'Prozentanteil',
    },
    shape: {
      door: 'Tür',
      ramp: 'Rampe',
      corridor: 'Gang',
      turning_circle: 'Wendekreis',
      threshold: 'Schwelle',
      parking_space: 'Stellplatz',
      lift_cabin: 'Aufzugskabine',
    },
    side: {
      front: 'vorne',
      back: 'hinten',
      left: 'links',
      right: 'rechts',
    },
    source: {
      projekt: 'Projekt',
      buero: 'Büro',
    },
    turn: {
      straight: 'geradeaus',
      left: 'links',
      right: 'rechts',
    },
  },
  boolean: {
    true: 'Ja',
    false: 'Nein',
  },
  // Die Ausnahmen zur flachen `fields`-Tabelle, nach PFAD im Kartenpayload.
  // „Ist“ stand über dem Grenzwert einer Berechnung — ein Name für zwei
  // Bedeutungen. Der Schlüssel ist der Pfad, an dem der Walker steht; ein
  // Schlüssel darf auf `?<Nachbarfeld>=<Wert>` enden, wenn die Bedeutung vom
  // Wert eines Nachbarfelds abhängt. Siehe die englische Quelle.
  fieldsByPath: {
    calculation: {
      limit: {
        value: 'Grenzwert',
        'value?comparator=between': 'Untergrenze',
      },
    },
  },
  fields: {
    title: 'Titel',
    note: 'Hinweis',
    reference: 'Fundstelle',
    label: 'Position',
    status: 'Beurteilung',
    summary: 'Zusammenfassung',
    content: 'Inhalt',
    kind: 'Art',
    confidence: 'Verlässlichkeit',
    query: 'Suchbegriff',
    value: 'Ist',
    required: 'Soll',
    unit: 'Einheit',
    comparator: 'Vergleich',
    provenance: 'Herkunft des Werts',
    tolerance: 'Toleranz',
    missing: 'Was fehlt',
    document: 'Regelwerk',
    section: 'Punkt',
    edition: 'Ausgabe',
    excerpt: 'Zitat',
    rationale: 'Begründung',
    patch: 'Änderungen',
    preview: 'Vorschau',
    op: 'Vorgang',
    path: 'Feld',
    storeys: 'Geschosse',
    markers: 'Bezugslinien',
    height_m: 'Höhe (m)',
    below_grade: 'Unter Gelände',
    riser_count: 'Anzahl Stufen',
    riser_height: 'Steigung',
    tread_depth: 'Auftritt',
    width: 'Breite',
    comfort_note: 'Schrittmaßregel',
    shape: 'Bauteil',
    dimensions: 'Maße',
    parcel_width_m: 'Grundstücksbreite (m)',
    parcel_depth_m: 'Grundstückstiefe (m)',
    building_width_m: 'Gebäudebreite (m)',
    building_depth_m: 'Gebäudetiefe (m)',
    sides: 'Seiten',
    side: 'Grundstücksgrenze',
    required_m: 'Erforderlich (m)',
    actual_m: 'Tatsächlich (m)',
    segments: 'Wegabschnitte',
    total_length: 'Gesamtlänge',
    start_label: 'Beginn',
    exit_label: 'Ausgang',
    length_m: 'Länge (m)',
    turn: 'Richtungswechsel',
    glass_area: 'Lichteintrittsfläche',
    obstruction: 'Verbauung',
    room_floor_area_m2: 'Raumfläche (m²)',
    window_head_height_m: 'Sturzhöhe (m)',
    window_sill_height_m: 'Parapethöhe (m)',
    distance_m: 'Abstand (m)',
    context: 'Ort',
    fall_height: 'Absturzhöhe',
    rail_height: 'Geländerhöhe',
    max_opening: 'Größte Öffnung',
    bottom_gap: 'Bodenabstand',
    has_horizontal_elements_in_climb_zone: 'Übersteigbare Horizontalen',
    coverage: 'Bebauungsgrad',
    density: 'Geschossflächenzahl',
    parcel_area_m2: 'Grundstücksfläche (m²)',
    footprint_area_m2: 'Bebaute Fläche (m²)',
    gross_floor_area_m2: 'Bruttogeschossfläche (m²)',
    route_width: 'Zufahrtsbreite',
    walk_distance_to_entrance: 'Weg zum Zugang',
    gate_clearance_height: 'Lichte Durchfahrtshöhe',
    aufstellflaeche: 'Aufstellfläche',
    gebaeudeklasse: 'Gebäudeklasse',
    components: 'Bauteile',
    documents: 'Dokumente',
    file_name: 'Datei',
    snippet: 'Fundstelle im Text',
    page: 'Seite',
    source: 'Herkunft',
    score: 'Relevanz',
    steps: 'Schritte',
    limit: 'Grenzwert',
    upper: 'Obergrenze',
    operands: 'Rechengrößen',
    operation: 'Rechenart',
    factor: 'Faktor',
    step: 'Aus Schritt',
    before: 'Bisher',
    after: 'Dann',
    length: 'Länge',
    distance_to_facade: 'Abstand zur Fassade',
  },
}
