import type { en } from '../en'

/** chat namespace — populated during component i18n. */
export const chat: typeof en.chat = {
  actions: {
    dismiss: 'Schließen',
  },
  effortDial: {
    title: 'Aufwand',
    trigger: 'Aufwand: {level}',
    faster: 'Schneller',
    smarter: 'Intelligenter',
    help: 'Wie lange Piloti nachdenkt, bevor es antwortet. Mehr Aufwand hilft bei verzwickten Fragen, kostet aber Zeit und Tokens. Gilt für diesen Chat.',
    maximumWarning:
      'Selten klüger als Hoch. Piloti denkt viel länger, kostet weit mehr Tokens und verrennt sich eher.',
    levels: {
      minimal: 'Minimal',
      low: 'Niedrig',
      medium: 'Mittel',
      high: 'Hoch',
      xhigh: 'Maximal',
    },
  },
  sourcePreview: {
    chipAria: 'Quelle ansehen: {label}',
    view: 'Ansehen',
    projectDocument: 'Projektunterlage',
    corpusDocument: 'Baurecht & Richtlinien',
    risDocument: 'Rechtsquelle (RIS)',
    citedPassage: 'Fundstelle',
    cited: 'Zitiert',
    loadFailed: 'Die Quellenvorschau konnte nicht geladen werden. Bitte versuchen Sie es erneut.',
    bindingLabel: 'Bindungswirkung',
    // Coarse binding classification beside the tier badge. `unbekannt` has no
    // entry on purpose — an unclassified source shows no pill at all.
    binding: {
      binding: 'Bindend',
      declared_binding: 'Verbindlich erklärt',
      interpretive: 'Auslegend',
    },
    openExternal: 'Im RIS öffnen',
    // Office-Dateien (Word, Excel, PowerPoint, ODF, RTF) zeigt der Viewer als
    // PDF, das Piloti aus dem Original erzeugt (ADR-0070); das Original bleibt
    // unverändert und herunterladbar.
    renditionNote: 'PDF-Vorschau des Originals',
    renditionPending: 'PDF-Vorschau wird erstellt…',
    downloadOriginal: 'Original herunterladen',
    // Coarse source kind (ADR-0026) shown in the info popover. Preferred
    // over `origins` because the origin token is kb/ris/web only, so a
    // knowledge-base copy of a legal text reads as project material.
    kinds: {
      building_law: 'Baurecht & Richtlinien',
      office: 'Büroablage',
      project: 'Projektwissen',
      // Eine Quelle aus einem anderen Projekt, die als Vorbild dient (ADR-0094); gleiche Farbe wie „Projektwissen“.
      praezedenz: 'Präzedenzfall',
      web: 'Webquelle',
    },
    origins: {
      kb: 'Projektwissen',
      ris: 'Recht & Richtlinien (RIS)',
      web: 'Webquelle',
    },
  },
  // Dokumentraster: echte Projekt-/Büroablage-Dateien, die der Assistent als
  // anklickbare Vorschaukarten anzeigt (`document_grid`-Karte / `surface_documents`).
  documentGrid: {
    countOne: '1 Dokument',
    countOther: '{count} Dokumente',
    forQuery: '„{query}“',
    source: {
      project: 'Projekt',
      office: 'Büro',
    },
    // Eine referenzierte Datei, die sich nicht mehr auf eine Dokumentzeile
    // auflösen lässt — eine ehrliche, handlungsfähige Karte (in der Büroablage / in den
    // Projektdateien öffnen) statt einer stummen toten Kachel.
    unresolvedHint: 'Der Assistent hat diese Datei referenziert.',
    openInOfficeShelf: 'In der Büroablage öffnen',
    openInFiles: 'In den Projektdateien öffnen',
    // Der Auflösungs-Abruf ist fehlgeschlagen — eine Wiederholaktion statt einer
    // dauerhaft toten Kachel.
    loadError: 'Dokumente konnten nicht geladen werden.',
    retry: 'Erneut versuchen',
    openAria: 'Dokument öffnen: {label}',
    thisFile: 'Diese Unterlage',
    choose: 'Welche Datei?',
    // Ruhige Quittung, wenn die Karte genau eine Datei neben dem Chat geöffnet hat.
    showing: '{label} wird angezeigt',
  },
  // Eine Datei, die die Antwort im Fließtext beim Namen nennt („Beginnen Sie mit
  // pd8280-2.pdf") — kein Beleg, sondern ein Zeiger auf ein Dokument, das die
  // Leserin besitzt. Der Klick öffnet es neben der Antwort.
  fileReference: {
    openAria: 'Datei öffnen: {name}',
    // Das Dokument, das Piloti lesen kann: Öffnen heißt hier zugleich, dass
    // sich die nächste Frage darauf bezieht — eine Beschriftung, die nur die
    // Hälfte davon nennt, überrascht genau die Leserin, für die sie da ist.
    openAskAria: '{name} öffnen und dazu fragen',
    open: 'Neben der Antwort öffnen',
    openAsk: 'Öffnen und dazu fragen',
    pages: '{count, plural, one {# Seite} other {# Seiten}}',
    // Wenn die Antwort den Namen anders geschrieben hat als die Datei heißt.
    writtenAs: 'Im Text: {name}',
    // Regal, aus dem die Datei stammt — dieselbe Unterscheidung wie bei den
    // Quellen: geteiltes Projektwissen, die Büroablage, private Beilage.
    shelf: {
      project: 'Projektdateien',
      office: 'Büroablage',
      session: 'Beilage in diesem Chat',
    },
    notIndexed:
      'Abgelegt, nicht gelesen. Sie können die Datei öffnen, aber Piloti zitiert sie nicht.',
    failed: 'Lesen fehlgeschlagen. Piloti kann diese Datei nicht zitieren.',
    // Von der Inhaltsprüfung zurückgehalten (ADR-0086): nie „freigeben“.
    held: 'Zurückgehalten: Die Inhaltsprüfung hält diese Datei von Piloti fern. Piloti zitiert sie erst, wenn jemand sie zulässt.',
  },
  composer: {
    /** Shown when the reader holds project:view but not project:chat. */
    noProjectChatPermission:
      'Piloti steht Ihnen in diesem Projekt derzeit nicht zur Verfügung. Wenn Sie nur Lesezugriff haben, kann Ihnen eine Projektadministratorin oder ein Projektadministrator die Rolle „Mitwirkender“ erteilen.',
    placeholder: 'Fragen Sie Piloti zu diesem Projekt …',
    sources: 'Datengrundlage',
    sourcesAria: 'Datengrundlage – {enabled} von {total} Quellen aktiv. Öffnet die Datenquellen.',
    scopeAria: 'Suchbereich: {project}',
    scopeFallback: 'Dieses Projekt',
    scopeCurrent: 'Aktuelles Projekt',
    scopeAll: 'Alle Projekte',
    scopeAllSoon: 'Bald verfügbar – projektübergreifende Suche ist noch nicht möglich.',
    // Mobile-only cue: the source/scope labels collapse to icons on phones, so a
    // tiny one-line hint under the composer keeps the active source count legible.
    sourcesActiveMobile: '{count, plural, one {# Quelle} other {# Quellen}} aktiv',
  },
  // Spracheingabe im Eingabefeld (features/dictation).
  dictation: {
    start: 'Diktieren',
    startHint:
      'Sprechen Sie, Piloti schreibt es in Ihre Nachricht. Stoppt nach {seconds} Sekunden.',
    stop: 'Beenden und einfügen',
    recording: 'Aufnahme, {elapsed}',
    transcribing: 'Wird verschriftlicht …',
    unavailable: {
      unsupported: 'Dieser Browser kann nicht vom Mikrofon aufnehmen.',
      insecure: 'Spracheingabe braucht eine sichere (https-)Verbindung.',
      noFormat: 'Dieser Browser nimmt in keinem Format auf, das Piloti verschriftlichen kann.',
      denied:
        'Der Mikrofonzugriff ist blockiert. Erlauben Sie ihn in den Website-Einstellungen des Browsers und laden Sie die Seite neu.',
    },
    errors: {
      noMicrophone: 'Es wurde kein Mikrofon gefunden.',
      denied: 'Der Mikrofonzugriff wurde nicht erlaubt.',
      rateLimited: 'Zu viele Aufnahmen in kurzer Zeit. Versuchen Sie es in einer Minute erneut.',
      tooLarge: 'Die Aufnahme ist zu groß zum Verschriftlichen.',
      notConfigured: 'Spracheingabe ist gerade nicht verfügbar.',
      failed: 'Die Aufnahme konnte nicht verschriftlicht werden. Ihre Nachricht ist unverändert.',
    },
  },
  // Der Reiter einer Quellenkarte in der Herleitung: die grobe Ebene, wenn der
  // Server keine feine Lane benannt hat, und das Regal, auf dem das Dokument
  // laut Wire liegt (ADR-0047: Deutsch ist Darstellung, nie Transport).
  sourceTabs: {
    law: 'Baurecht',
    project: 'Projektwissen',
    office: 'Büroablage',
    auto: 'Web',
    model: 'Modellmessung',
    shelves: {
      office_shelf: 'Büroablage',
      project: 'Projektwissen',
      session: 'Private Sitzung',
      base: 'Basiswissen',
    },
    // Die feine Spur eines Dokuments (`norm_registry`), in der Sprache der
    // Lesenden: Das Backend schickt sie nur deutsch (`laneLabel`). Projekt,
    // Büroablage und Web fehlen hier, sie sagt die Ablage oben.
    lanes: {
      building_law_oib: 'OIB-Richtlinie',
      building_law_oib_guide: 'OIB-Leitfaden',
      building_law_oib_explanatory_note: 'OIB-Erläuterung',
      building_law_oib_definitions: 'OIB-Begriffsbestimmungen',
      building_law_oib_reference: 'OIB-Referenzdokument',
      building_law_oib_amendment: 'OIB-Änderungsdokument',
      building_law_ris: 'Rechtsquelle (RIS)',
      building_law_base: 'Basisdokument',
      building_law_federal: 'Bundesrecht',
      building_law_state: 'Landesrecht',
      building_law_ordinance: 'Verordnung',
      authority: 'Behördliche Information',
      external_standard: 'Externe Norm',
      office_piloti: 'Piloti-Dokument',
      measurement: 'Modellmessung',
    },
  },
  shortcuts: {
    label: 'Schnellzugriff',
    presetAria: 'Quellen-Voreinstellung: {label}',
    presets: {
      law: 'Baurecht & Richtlinien',
      project: 'Projektunterlagen',
      office: 'Büroablage',
    },
  },
  greeting: {
    morning: 'Guten Morgen',
    afternoon: 'Guten Tag',
    evening: 'Guten Abend',
    withName: '{greeting}, {name}.',
    // Der leere Chat in einem Projekt sagt EINE Sache über sich: dass Piloti
    // nicht nur antwortet, sondern schreibt. Sonst entdeckt das nur, wer eine
    // Bitte zufällig als Auftrag formuliert (Ledger 23). Nur im Projekt, weil
    // ohne Projekt kein Ablageort existiert, in den ein Entwurf ginge.
    projectWrites:
      'Piloti beantwortet nicht nur Fragen – auf Zuruf schreibt Piloti Aktenvermerke, Notizen und Entwürfe direkt in die Projektdateien.',
  },
  // Thread role tabs (click-dummy overhaul, WS-3).
  roles: {
    input: 'Eingabe',
    result: 'Ergebnis',
    // Rollen-Tab für eine konversationelle / klärende Antwort (routing_decision
    // = 'meta' oder answer_meta.kind = 'direct': Begrüßungen, Fähigkeits- und
    // Rückfragen) — deutlich abgesetzt von einem inhaltlichen Baurecht-'Ergebnis'.
    note: 'Hinweis',
    // Walkthrough: eine geführte Antwort ohne Urteil — nicht das Ergebnis-Dokument.
    answer: 'Antwort',
  },
  // Die Befundmatrix über dem Bericht: eine Zeile je Anforderung, die der
  // Bericht gegen das Projekt gelesen hat.
  findings: {
    label: 'Befunde',
    page: 'S. {page}',
    labelResults: 'Ergebnisse',
    columns: {
      requirement: 'Anforderung',
      value: 'Wert',
      reference: 'Fundstelle',
      status: 'Status',
      note: 'Anmerkung',
    },
    status: {
      met: 'erfüllt',
      not_met: 'nicht erfüllt',
      open: 'offen',
      not_applicable: 'nicht anwendbar',
    },
    grounding: { sourced: 'belegt', derived: 'abgeleitet', open: 'ohne Beleg' },
    // Ein offener Befund lässt sich als eigener Auftrag klären; der Lauf
    // erscheint als Block in diesem Verlauf.
    clarify: 'Klären',
    /** Unter der Matrix in einem abgeschlossenen Projekt, wo „Klären“ stünde (ADR-0090). */
    clarifyClosed: 'Abgeschlossenes Projekt: keine neue Recherche zu offenen Befunden.',
    commissioned: 'Aufgabe angelegt',
    // Gegenüber dem vorigen Bericht zum selben Thema.
    change: {
      new: 'neu',
      changed: 'geändert',
      dropped: '{count, plural, one {# Befund entfallen:} other {# Befunde entfallen:}}',
    },
  },
  answerSources: {
    label: 'Belegt durch',
    ariaLabel: 'Quellen, auf die sich diese Antwort stützt',
    // Ehrliche „Lücke“-Zeile: eine inhaltliche Antwort ohne Quellenangabe zeigt
    // dies in der neutralen --source-auto-Familie, statt die fehlende Beleglage
    // zu verbergen (Designsprache — erstklassige Wissenslücken-Behandlung).
    gapLabel: 'Ohne Quellenbeleg',
    gapAria: 'Diese Antwort nennt keine Quellen',
    // Die zusammengeführte Liste nummeriert jede Quelle so, wie die [N]-Marker
    // im Antworttext sie zitieren, und nennt die belegte Seite nach dem Chip.
    sourceNumber: 'Quelle {number}',
    page: 'S. {page}',
    pages: 'S. {pages}',
    // Die Meldezeile einer Präzedenz aus einem anderen Projekt: Projekt, Status, dann das Bundesland.
    precedentProject: '{name} · {status}',
    projectStatus: { active: 'laufend', paused: 'ruhend', closed: 'abgeschlossen' },
    // Quellen jenseits der acht Chips falten sich hinter denselben Auslöser wie
    // die gelesenen Quellen: die Zahl zuerst, jeder Name beim Aufklappen.
    more: '+{count} weitere',
    less: 'Weniger anzeigen',
    // Die Fundstelle in der Zählung des Gesetzes selbst: ein Punkt der
    // Richtlinie, wenn der Chunker einen ermittelt hat, sonst nur die Seite.
    clause: 'Pkt. {clause}',
    clausePage: 'Pkt. {clause} · S. {page}',
    // Zitate zum Weiterverwenden — je Quelle als Fachtext, für die ganze
    // Antwort in den Formaten, die externe Werkzeuge einlesen.
    copyCitation: 'Zitat kopieren',
    copied: 'Kopiert',
    copyCitationAria: 'Zitat kopieren: {label}',
    copyFailed: 'Das Zitat konnte nicht kopiert werden.',
    citeAll: 'Zitieren',
    citeAsLabel: 'Alle Quellen kopieren als',
    formats: {
      quotes: { label: 'Zitiertext', hint: 'Die belegten Sätze, als Liste' },
      fachtext: { label: 'Quellenangabe', hint: 'Für Befund, Gutachten, Einreichung' },
      apa: { label: 'APA', hint: 'Formatiertes Literaturverzeichnis' },
      bibtex: { label: 'BibTeX (.bib)', hint: 'LaTeX, JabRef' },
      ris: { label: 'EndNote/Zotero (.ris)', hint: 'Literaturverwaltung' },
      'csl-json': { label: 'CSL-JSON', hint: 'Zotero, Word, pandoc' },
    },
    // Hinweis unter der Quellenzeile, wenn die Zitatprüfung nicht belegbare
    // Quellenangaben entfernt hat (WP-A `citations_removed`).
    citationsRemoved:
      '{count, plural, one {# Quellenangabe entfernt} other {# Quellenangaben entfernt}} (nicht verifizierbar)',
    citationsRemovedReasonsLabel: 'Gründe',
    // Die Recherche wurde an der Iterationsgrenze abgebrochen, nicht beendet.
    // Eine Aussage über die BELEGLAGE, keine Fehlermeldung und kein Urteil über
    // die Antwort — deshalb im selben Register wie die Quellenzeile darüber.
    // Unabhängig von der Selbsteinschätzung: die bewertet, ob die Aussagen
    // belegt sind, nicht ob die Suche zu Ende gelaufen ist.
    researchTruncated:
      'Recherche vorzeitig beendet — die Antwort stützt sich auf die bis dahin gefundenen Belege',
    // Derselbe Sachverhalt, wenn die Antwort gar keine Quellen nennt: der Satz
    // oben verspräche „die bis dahin gefundenen Belege“, die es nicht gibt.
    researchTruncatedWithoutSources: 'Recherche vorzeitig beendet, bevor Belege gefunden wurden',
    // Die Suche lief und fand nichts; die Antwort steht trotzdem da (ADR-0125),
    // und dieser Satz sagt, worauf sie dann beruht.
    lookupFoundNothing:
      'Die Suche hat keine Quellen gefunden. Diese Antwort beruht auf allgemeinem Wissen und ist nicht belegt.',
    // WOMIT sie endete — als kurzer Zusatz in Klammern hinter dem jeweils
    // zutreffenden Satz oben. Dass vorzeitig Schluss war, ist der Sachverhalt;
    // woran es lag, entscheidet, ob eine erneute Anfrage etwas bringt.
    //
    // Schlüssel ist wörtlich das stabile Token des Backends, damit die Zuordnung
    // gegen den Erzeuger prüfbar bleibt. Ein Token ohne Eintrag wird gar nicht
    // gerendert: `wall_clock` darf nie beim Leser ankommen.
    truncationReason: {
      wall_clock: 'Zeitgrenze erreicht',
      // Ein Timeout von unten (Anbieter/Transport), nicht das eigene Budget des
      // Laufs. Für den Leser ist beides dasselbe: die Recherche endete an einer
      // Zeitgrenze. Getrennt gezählt wird es nur intern.
      upstream_timeout: 'Zeitgrenze erreicht',
      step_limit: 'Schrittgrenze erreicht',
      user_requested: 'auf Ihren Wunsch beendet',
    },
    // Wodurch diese gerettete Antwort schwächer ist als die eines sauberen
    // Laufs. Gleiches Register wie oben — leise, sachlich, über die BELEGLAGE —
    // aber jede Zeile nennt etwas, woran der Leser anknüpfen kann; deshalb
    // stehen sie da und nicht im Abbruchsatz mit drin.
    degradedReason: {
      no_report_file:
        'Kein Recherchebericht abgelegt — diese Antwort ist die einzige Aufzeichnung des Laufs',
      no_valid_citations:
        'Keine Quellenangabe hielt der Prüfung stand — bitte prüfen Sie die Angaben vor der Verwendung selbst',
      cards_generation_failed:
        'Der Bericht ist vollständig, aber die daraus abgeleiteten Vorschläge konnten nicht erzeugt werden',
      basis_unread:
        'Nicht alle als Grundlage benannten Unterlagen wurden gelesen — welche fehlen, steht am Ende des Berichts',
    },
    // Die Gründe der Zitatprüfung, in der Sprache des Lesers. Das Backend nennt
    // sie als Token (`url_not_in_registry`, …), und genau so standen sie bisher
    // im Tooltip; ein nicht zugeordnetes Token entfällt jetzt, statt roh
    // angezeigt zu werden.
    citationsRemovedReason: {
      url_not_in_registry: 'URL nicht unter den abgerufenen Quellen',
      citation_key_not_in_registry: 'Dokument nicht unter den abgerufenen Quellen',
      unverifiable: 'Kein prüfbares Ziel in der Quellenangabe',
      duplicate: 'Doppelte Quellenangabe',
      ungrounded: 'Antwort nicht auf eine Quellenangabe gestützt',
      quote_unverified: 'Zitat nicht verifizierbar',
    },
  },
  // Die Antwort aus Piloti herausbekommen — für Prüfvermerk, Mail, Einreichung.
  // Zwei Icon-Schaltflächen in der Metazeile der Antwort; die zweite gibt es nur,
  // wenn die Antwort überhaupt Quellen aufgelöst hat.
  answerActions: {
    copy: 'Antwort kopieren',
    copyWithSources: 'Antwort mit ausgeschriebenen Quellenangaben kopieren',
    copied: 'Kopiert',
    copyFailed: 'Die Antwort konnte nicht kopiert werden.',
    // Überschrift, unter der die ausgeschriebene Quellenliste steht — dieselbe,
    // die die Antworten selbst schreiben, damit eine eingefügte Antwort gleich
    // aussieht, egal über welche Schaltfläche sie kopiert wurde.
    sourcesHeading: 'Quellen',
    untitledSource: 'Quelle ohne Titel',
    downloadDocx: 'Als Word-Dokument herunterladen',
    downloadFailed: 'Das Word-Dokument konnte nicht erstellt werden.',
    // Systemdialog „Teilen“ am Telefon: Beschriftung und Titel der geteilten Nachricht.
    share: 'Antwort teilen',
    shareTitle: 'Antwort von Piloti',
  },
  // Die Abschnittsliste einer langen Antwort (Bericht): auf dem Telefon der Weg zu
  // einem Abschnitt, ohne bis nach oben zu scrollen.
  outline: {
    label: 'Abschnitte',
    count: '{count, plural, one {# Abschnitt} other {# Abschnitte}}',
    close: 'Schließen',
    title: 'Abschnitte',
    description: 'Zu einem Abschnitt dieser Antwort springen.',
  },
  // Der Zitat-Peek: was diese Fundstelle IST, bevor man sie öffnet.
  citationPeek: {
    pageThumbnail: 'Seite {page}',
    thumbnailLoading: 'Die Seite wird gezeichnet',
    wholeDocument: 'Gesamtes Dokument',
    openAtPage: 'An dieser Stelle öffnen',
    notOpenable: 'Zu dieser Quelle liegt in Piloti keine Datei vor.',
    sheetTitle: 'Quelle {number}',
    sheetDescription: 'Die Fundstelle im Wortlaut und der Weg ins Dokument.',
    // Das Dokument IST da — nur sein Format kann Piloti nicht zeichnen. Ohne
    // diesen Satz las sich das Fehlen der Öffnen-Schaltfläche als „die Datei
    // ist weg", und genau das wurde gemeldet.
    noInlineViewer:
      'Dieses Dateiformat lässt sich in Piloti nicht anzeigen. Sie können das Dokument herunterladen und in Ihrem Programm öffnen.',
    download: 'Dokument herunterladen',
    downloading: 'Wird vorbereitet…',
    copyLink: 'Link kopieren',
    copyLinkAria: 'Link zu dieser Fundstelle kopieren: {label}',
    markerAria: 'Quelle {number}: {label} — Vorschau öffnen',
    pendingAria: 'Quelle {number} — wird geprüft',
    lociLabel: '{count, plural, one {# Fundstelle} other {# Fundstellen}}',
    lociAria: 'Fundstellen in diesem Dokument',
    lociPosition: '{index}/{count}',
    previousLocus: 'Vorherige Fundstelle',
    nextLocus: 'Nächste Fundstelle',
    retrievedOnly: 'Gelesen',
    // Das Dokument ist eine Fassung, die eine Person durch eine neuere ersetzt hat. Die Zitation bleibt wahr
    // für die Datei, die sie nennt; der Leser soll es nur wissen, bevor er sich darauf verlässt.
    olderRevision: 'Ältere Fassung – aktuell:',
    openCurrentRevisionAria: 'Aktuelle Fassung öffnen: {name}',
    currentRevisionUnavailable: 'Die aktuelle Fassung lässt sich nicht öffnen.',
  },
  breadcrumb: {
    ariaLabel: 'Navigationspfad',
    renameAria: 'Sitzung umbenennen – zum Bearbeiten klicken',
    renameInputAria: 'Sitzungstitel',
  },
  cards: {
    askAbout: {
      chip: 'Dazu fragen',
      chipAria: 'Frage zu „{subject}“ ins Eingabefeld übernehmen',
      missingWithDetail:
        'Bei „{subject}“ fehlt eine Angabe: {missing}. Wie kann ich das nachreichen, und was gilt bis dahin?',
      missingOnly:
        'Bei „{subject}“ fehlt eine Angabe. Welche Angabe wird dafür benötigt, und woher bekomme ich sie?',
    },

    // ── Gemeinsame Schematik-Chrome ────────────────────────────────────────
    // `kit.tsx` zeichnet acht Karten. Sein Wortschatz steht hier, weil er
    // auf jeder einzelnen erscheint: Verdikt, fehlende Angabe, Herkunft.
    kit: {
      eyebrow: 'Skizze',
      status: {
        pass: 'erfüllt',
        fail: 'nicht erfüllt',
        warning: 'grenzwertig',
        needsInput: 'Angabe fehlt',
      },
      // Steht dort, wo eine Zahl stünde, die niemand kennt. Nie eine geratene
      // Zahl — ein leeres Feld liest sich als Aussage über das Gebäude.
      missingValue: 'fehlende Angabe',
      provenance: {
        declared: 'laut Modell',
        computed: 'gemessen',
        inferred: 'vermutlich',
      },
      // Langform im Tooltip, wo Platz ist, das Wort zu erklären.
      provenanceTitle: {
        declared: 'Diese Zahl steht so in der IFC-Datei — eine Angabe der Architektin.',
        computed: 'Aus der Geometrie gemessen, nicht deklariert. Die Toleranz gehört zur Aussage.',
        inferred: 'Aus einer Heuristik abgeleitet. Ein Vorschlag zur Bestätigung, kein Befund.',
      },
      toleranceStraddlesLimit:
        'Die Messtoleranz reicht über den Grenzwert: bei dieser Genauigkeit ist nicht entschieden, ob der Wert eingehalten ist. Für einen Nachweis genauer aufmessen.',
    },
    followUps: {
      eyebrow: 'Weiterfragen',
      groupAria: 'Weiterführende Fragen',
      // Der eine clientseitige Chip unter einer langen Antwort: das Angebot,
      // das sonst niemand entdeckt — Piloti schreibt auch (Ledger 23).
      fileNote: 'Als Aktenvermerk schreiben',
      // Was der Chip in den Eingabebereich schreibt. Bewusst nicht die
      // Beschriftung: „Als Aktenvermerk schreiben“ ist ein Satzfragment und
      // keine Bitte.
      fileNotePrefill: 'Schreib das als Aktenvermerk in mein Projekt.',
    },
    workReport: {
      eyebrow: 'Arbeitsstand',
      done: 'Erledigt',
      proposed: 'Vorgeschlagen, wartet auf Sie',
      blocked: 'Blockiert',
      next: 'Als Nächstes',
      who: 'Wer: {who}',
      due: 'bis {due}',
    },
    keyTakeaways: {
      eyebrow: 'Das Wichtigste',
    },
    callout: {
      note: 'Hinweis',
      warning: 'Achtung',
      deadline: 'Frist',
      tip: 'Tipp',
      more: 'Mehr dazu',
      less: 'Weniger',
    },
    // Ein auf wenige Zeilen gekürzter Text, der sich per Tipp öffnen lässt (ClampedText).
    clamp: {
      more: 'Mehr anzeigen',
      less: 'Weniger anzeigen',
    },
    calculation: {
      eyebrow: 'Rechenweg',
      result: 'Ergebnis',
      limitLabel: 'Grenzwert',
      // Ein Bereich als Grenzwert, etwa 59–65 cm der Schrittmaßregel. Der
      // Gedankenstrich wird vom Code gesetzt, also steht die Form hier.
      limitRange: '{lower}–{upper} {unit}',
      // Ein Operand, der das Ergebnis eines früheren Schritts ist.
      fromStep: 'aus Schritt {step}',
      // Steht dort, wo das Ergebnis stünde. Nie eine halbe Zahl: einem
      // Rechenweg ohne alle Werte fehlt das Ergebnis, und eines trotzdem
      // hinzuschreiben ist genau der Fehler, den diese Karte ausschließt.
      undecidable: 'Mit den vorliegenden Angaben nicht berechenbar.',
      undefinedResult: 'Durch null geteilt — das Ergebnis ist nicht definiert.',
      sourcesMore: 'Woher die Zahlen kommen',
      sourcesLess: 'Weniger',
      // Steht in der Aufklappung, wo die Eingangswerte ohnehin geprüft werden:
      // gerechnet hat die Karte, zu prüfen sind die Werte.
      computedNote:
        'Das Ergebnis wird von dieser Karte aus den obigen Werten berechnet, nicht aus der Antwort übernommen.',
    },
    // Ein Dokument, das Piloti in den Arbeitsordner dieser Unterhaltung
    // geschrieben hat. Keine Projektunterlage: nichts davon ist abgelegt,
    // indexiert oder zitierfähig, bis eine Person es ins Projekt übernimmt —
    // genau das wird die (noch wirkungslose) Aktion unter der Karte tun.
    documentDraft: {
      eyebrow: 'Entwurf',
      // Wie oft dieser Pfad in dieser Unterhaltung geschrieben wurde. Eigenes
      // Token neben der Größe, damit eine Sprache das „v" fallen lassen kann.
      version: 'v{version}',
      // Der Stand eines einmal geschriebenen Entwurfs: Ein Schreibvorgang ist
      // keine Geschichte, also nennt die Karte den Zustand, statt ihn zu zählen.
      draftState: 'Entwurf',
      // Der Entwurf liegt nur in dieser Unterhaltung. „Ins Projekt ablegen"
      // legt ihn über die Ablagetür des BFF ab, in der Sitzung der Lesenden —
      // ein Druck, keine Bitte, keine zweite Runde. Ein namensgleiches
      // Dokument, das schon im Projekt liegt, ist ein 409, den die Karte mit
      // einer ausdrücklichen Bestätigung beantwortet statt mit einer stillen
      // zweiten Kopie.
      file: 'Ins Projekt ablegen',
      filing: 'Wird abgelegt …',
      fileError: 'Das Ablegen hat nicht geklappt. Bitte erneut versuchen.',
      fileConflict: 'Ein Dokument mit diesem Namen liegt bereits im Projekt.',
      fileAnyway: 'Trotzdem ablegen',
      // Die Referenz ist abgelegt und eine Person hat die Fassung
      // weitergereicht: nichts erneut zu versuchen und nichts zu bestätigen —
      // ab hier sind die Dateien zuständig.
      fileSubmitted: 'Dieser Entwurf ist bereits abgelegt. Weiter unter Dateien.',
      // Die Lesefläche des unabgelegten Entwurfs: Die Bytes liegen im
      // Arbeitsordner des Agenten und kommen über die Entwurfs-Vorschautür des
      // BFF. Ein Lesen, also schreibt sie nichts und bleibt presentational.
      preview: 'Entwurf ansehen',
      previewLoading: 'Entwurf wird geladen …',
      previewError: 'Der Entwurf konnte nicht geladen werden.',
      previewRetry: 'Erneut versuchen',
      // Ab hier liegt das Dokument im Projekt.
      filed: 'Liegt als Entwurf im Projekt',
      open: 'Im Projekt öffnen',
      submit: 'Zur Freigabe einreichen',
      submitting: 'Wird eingereicht …',
      submitted: 'Zur Freigabe eingereicht – wartet auf eine Person',
      // Der Zustand, den eine Person schon gesetzt hat. Kein Knopf: Was jetzt
      // passiert, entscheidet sie unter Dateien.
      inReview: 'In Prüfung',
      changesRequested: 'Änderungen angefordert',
      approved: 'Freigegeben',
      published: 'Veröffentlicht',
      // Eine Fassung, die eine neuere überholt hat: weder Entwurf noch
      // Freigabe — sie ist gelesen, aber nicht mehr die aktuelle.
      ersetzt: 'Ersetzt',
      error: 'Das Einreichen hat nicht geklappt. Bitte unter Dateien erneut versuchen.',
    },
    // Eine Aufgabe, die Piloti nach diesem Chat selbständig erledigt
    // (ADR-0051). Die Karte bietet nichts an: die Zeile existiert schon, wenn
    // sie erscheint, und der Laufblock darunter sagt, wie es steht — die Karte
    // ist die Quittung (was, welcher Art, bis wann) und nennt keinen Status.
    // Wo Piloti in einem Dokument hingesehen hat (ADR-0128): je Ansicht die
    // Seite und die Stelle, und was Piloti in der Runde gezeigt hat.
    look: {
      eyebrow: 'Angesehen',
      looked: 'S. {page}',
      shown: 'Gezeigt auf S. {page}',
      wholePage: 'ganze Seite',
      // Was Piloti von der Seite abgelesen hat, nie eine Messung (ADR-0125).
      reading: 'Gelesen: {reading}',
      readingNote: 'Von Piloti abgelesen, nicht gemessen.',
      embeddedImage: 'Bild {index}',
      open: '{document}, S. {page} öffnen',
    },
    // Zwei Fassungen eines Dokuments, die Änderungen auf jeder eingerahmt (ADR-0128, V10).
    revisionCompare: {
      eyebrow: 'Fassungen verglichen',
      page: 'S. {page}',
      older: 'Ältere Fassung',
      newer: 'Neuere Fassung',
      open: '{side}, S. {page}: mit den Änderungen öffnen',
    },
    taskCreated: {
      eyebrow: 'Aufgabe',
      due: 'bis {date}',
      open: 'Chat öffnen',
      // Die vier Arten, in den Worten, in denen die Nutzerin sie beauftragt hat.
      kind: {
        complianceCheck: 'Normprüfung',
        submissionCheck: 'Einreichcheck',
        document: 'Dokument',
        revision: 'Überarbeitung',
      },
    },
    // Die Änderung an der Ablage, die Piloti VORGESCHLAGEN hat. Bis zum
    // Annehmen ist nichts geschehen: Der Agent kann gar keine Dokumentzeile
    // schreiben, die Karte ist also alles, was hinten passiert ist. Das
    // Annehmen ruft dieselben Routen wie die Dateiablage — in der Sitzung der
    // Lesenden.
    fileOperationProposal: {
      // Eine Augenbraue je Verb: Welche Art von Änderung das ist, gehört vor
      // die erste Zeile und nicht dahinter.
      eyebrow: {
        move: 'Verschieben',
        rename: 'Umbenennen',
        create_folder: 'Neuer Ordner',
        assign: 'Zuweisen',
      },
      // Eine Verschiebung, die ihren Zielordner erst anlegt: Er steht vor den Zeilen.
      newFolder: 'Neuer Ordner',
      // Die oberste Ebene hat keinen Pfad, aber einen Namen, den Menschen sagen.
      root: 'Oberste Ebene',
      applied: {
        move: '{count, plural, one {Datei verschoben.} other {# Dateien verschoben.}}',
        rename: '{count, plural, one {Datei umbenannt.} other {# Dateien umbenannt.}}',
        create_folder: '{count, plural, one {Ordner angelegt.} other {# Ordner angelegt.}}',
        assign: '{count, plural, one {Datei zugewiesen.} other {# Dateien zugewiesen.}}',
      },
      // Einige Einträge einer Karte, die vor den Vorschlägen auf dem Server
      // entschieden wurde. WELCHE, wird dort nicht gespeichert (eine Entscheidung
      // ist eine Entscheidung und ein Zeitpunkt) — die Karte sagt, wo man nachsieht,
      // statt zu raten.
      partial:
        'Teilweise übernommen. Einige Einträge konnten nicht ausgeführt werden – sehen Sie unter Dateien nach.',
      // Eine Karte, deren Vorschlag der Server hält, nennt die Zahl der
      // gelungenen Einträge aus dem Ergebnis je Zeile.
      partialCount: '{applied} von {total} übernommen.',
      dismissed: 'Verworfen. Es wurde nichts geändert.',
      // Eine Karte ohne gespeicherten Vorschlag (eine Antwort aus der Zeit
      // davor, oder einer, den der Agent nicht ablegen konnte). Im Browser wird
      // nichts mehr ausgeführt: Der Vorschlag bleibt lesbar, übernehmen lässt er
      // sich nicht, und hier steht warum.
      notStored:
        'Konnte nicht als Vorschlag angelegt werden. Bitten Sie Piloti, die Änderung noch einmal vorzuschlagen.',
    },
    // Ein Vorschlag, den der Server hält (ADR-0105), gleich welcher Art: Datei-
    // änderung, Notiz oder Änderung am Projektkontext. Stand, Ergebnis und wer
    // entschieden hat, kommen aus diesem Objekt — jede Leserin sieht die
    // Entscheidung der Kollegin.
    proposalReceipt: {
      prompt: 'Übernehmen?',
      accept: 'Übernehmen',
      reject: 'Verwerfen',
      applying: 'Wird übernommen …',
      failed: 'Nichts konnte übernommen werden. Es wurde nichts geändert.',
      applyError: 'Konnte nicht übernommen werden.',
      dismissError: 'Konnte nicht verworfen werden.',
      decidedBy: {
        applied: 'Übernommen von {name} · {when}',
        partially_applied: 'Übernommen von {name} · {when}',
        failed: 'Versucht von {name} · {when}',
        dismissed: 'Verworfen von {name} · {when}',
      },
      // Der Name ist dieser Leserin nicht bekannt.
      someone: 'einer Kollegin oder einem Kollegen',
      // Der Klick kam an, nachdem jemand anderes entschieden hatte.
      overtaken: 'Inzwischen wurde darüber entschieden.',
      readOnly: 'Sie können diesen Vorschlag lesen, in diesem Projekt aber nicht übernehmen.',
      loadError: 'Der Stand dieses Vorschlags konnte nicht geladen werden.',
      memory: {
        confidence: { low: 'Sicherheit: gering', medium: 'Sicherheit: mittel', high: 'Sicherheit: hoch' },
        goesInto: {
          organization: 'Kommt in das Gedächtnis des Büros, für alle Projekte.',
          project: 'Kommt in das Gedächtnis dieses Projekts.',
        },
        supersedes: 'Ersetzt: „{note}“',
        onlyInProject: 'Nur im Projekt merken',
        saving: 'Wird gespeichert …',
        saved: 'Notiz gemerkt.',
        // Die Überschrift der entschiedenen Karte, wenn bekannt ist, wohin die Notiz kam.
        savedIn: { organization: 'Im Gedächtnis des Büros gemerkt.', project: 'Im Projekt gemerkt.' },
        dismissed: 'Verworfen. Es wurde nichts gemerkt.',
      },
      profile: {
        applied: 'Projektkontext aktualisiert.',
        dismissed: 'Verworfen. Der Projektkontext blieb unverändert.',
      },
    },
    // Eine Aktion, die Piloti über die MCP-Schnittstelle VORGESCHLAGEN hat
    // (ADR-0122). Bis zum Annehmen ist nichts geschehen; das Annehmen führt sie
    // in der Sitzung der Lesenden aus, die Route prüft die Berechtigung.
    operationProposal: {
      eyebrow: 'Aktion',
      // „{operation}“ ist der technische Name der Aktion, er bleibt unübersetzt.
      operation: 'Aktion: {operation}',
      inputLabel: 'Eingaben',
      // Ein langer Wert ist erst gekürzt; „Übernehmen“ wartet, bis jeder ganz gelesen ist.
      showAll: 'Ganz anzeigen ({length} Zeichen)',
      showLess: 'Weniger anzeigen',
      readAllFirst: '{count, plural, one {Lies den gekürzten Wert ganz, bevor du übernimmst.} other {Lies die # gekürzten Werte ganz, bevor du übernimmst.}}',
      targetsLabel: 'Betrifft',
      target: {
        project: 'Projekt {name}',
        document: 'Dokument {name}',
        folder: 'Ordner {name}',
        conversation: 'Chat {name}',
        bim_model: 'Modell {name}',
        upload_batch: 'Upload {name}',
        proposal: 'Vorschlag {name}',
        inbound_mail: 'E-Mail {name}',
        mail_thread: 'E-Mail-Verlauf {name}',
      },
      applied: 'Die Aktion wurde ausgeführt.',
      dismissed: 'Verworfen. Die Aktion wurde nicht ausgeführt.',
    },
    // Was Piloti an einem Dokument getan hat: Anmerkungen gesetzt, in einem
    // Thread geantwortet. Je Anmerkung ein „Übernehmen“ oder „Verwerfen“, und
    // der Weg in die Prüfansicht an genau diese Stelle. Eine Datei heißt hier
    // Dokument, nie „Plan“.
    canvasActivity: {
      headline: {
        proposed: '{count, plural, one {# Anmerkung vorgeschlagen} other {# Anmerkungen vorgeschlagen}}',
        repliedOne: 'Im Thread von #{number} geantwortet',
        repliedMany: 'In {count} Threads geantwortet',
        created: '{count, plural, one {# Anmerkung gesetzt} other {# Anmerkungen gesetzt}}',
        changed: '{count, plural, one {# Anmerkung geändert} other {# Anmerkungen geändert}}',
        deleted: '{count, plural, one {# Anmerkung gelöscht} other {# Anmerkungen gelöscht}}',
        repliedPart: 'in {threads, plural, one {einem Thread} other {# Threads}} geantwortet',
      },
      kinds: {
        hint: 'Hinweis',
        question: 'Rückfrage',
        defect: 'Mangel',
      },
      page: 'Seite {page}',
      repliedIn: 'Antwort im Thread von #{number}',
      show: 'Im Dokument zeigen',
      showMarkLabel: 'Anmerkung {number} im Dokument zeigen',
      showThreadLabel: 'Thread von Anmerkung {number} im Dokument zeigen',
      showError: 'Das Dokument konnte nicht geöffnet werden.',
      accept: 'Übernehmen',
      accepting: 'Wird übernommen …',
      acceptLabel: 'Anmerkung {number} übernehmen',
      reject: 'Verwerfen',
      rejectLabel: 'Anmerkung {number} verwerfen',
      state: {
        proposed: 'Vorgeschlagen',
        open: 'Übernommen',
        resolved: 'Erledigt',
        dismissed: 'Verworfen',
        gone: 'Nicht mehr vorhanden',
      },
      error: 'Konnte nicht gespeichert werden.',
      forbidden: 'Sie können diese Anmerkung nicht ändern.',
      // Was Piloti auf Bitte der Person an einer Anmerkung geändert hat, in
      // ihren Worten: „#4 erledigt“, „#4 Anna zugewiesen“.
      change: {
        taken: 'übernommen',
        reopened: 'wieder geöffnet',
        resolved: 'erledigt',
        dismissed: 'verworfen',
        assigned: '{name} zugewiesen',
        someone: 'jemandem',
        unassigned: 'Zuständigkeit entfernt',
        due: 'Frist {date}',
        undue: 'Frist entfernt',
        kind: 'als {kind} eingestuft',
        body: 'Text geändert',
      },
      status: {
        proposed: 'Vorschlag',
        open: 'offen',
        resolved: 'erledigt',
        dismissed: 'verworfen',
      },
      undo: 'Rückgängig',
      undoing: 'Wird rückgängig gemacht …',
      undoLabel: 'Änderung an Anmerkung {number} rückgängig machen',
      undone: 'Rückgängig gemacht',
      movedSince: 'Seitdem geändert, jetzt {state}',
      deleted: 'Anmerkung #{number} gelöscht',
      // Who the turn acted for, and why an undo did not happen (ADR-0109).
      forPerson: 'für {name}',
      movedOn: 'Jemand hat das inzwischen geändert, daher bleibt es, wie es ist.',
      alreadyUndone: 'Das wurde bereits rückgängig gemacht.',
      // Mehrere Vorschläge auf einmal (Übernehmen oder Verwerfen je Anmerkung
      // bleibt) und der Stand des Threads auf einen Blick.
      batch: {
        acceptAll: 'Alle übernehmen',
        accepting: 'Wird übernommen …',
        rejectRest: 'Übrige verwerfen',
        rejecting: 'Wird verworfen …',
        confirmTitle:
          '{count, plural, one {Diese Anmerkung verwerfen?} other {# Anmerkungen verwerfen?}}',
        confirmBody: 'Das lässt sich hier nicht rückgängig machen.',
        confirm: 'Verwerfen',
        cancel: 'Abbrechen',
        already: 'bereits erledigt',
        alreadyBy: 'bereits erledigt von {name}',
        failed:
          '{count, plural, one {Eine Anmerkung konnte nicht gespeichert werden.} other {# Anmerkungen konnten nicht gespeichert werden.}}',
      },
      thread: {
        count: '{count, plural, one {# Antwort} other {# Antworten}}',
        last: 'zuletzt {name}: „{excerpt}“',
        someone: 'jemand',
      },
    },
    verdictHeader: {
      confidenceHigh: 'hohe Sicherheit',
      confidenceMedium: 'mittlere Sicherheit',
      confidenceLow: 'geringe Sicherheit',
    },
    // ── Beschriftungen in den Zeichnungen ──────────────────────────────────
    // Was in der Skizze selbst steht. Symbole (±0,00, Ø, N), Einheiten und
    // Normbezeichnungen (A++ … G, DnT,w) stehen bewusst nicht hier: sie sind
    // in jeder Sprache dasselbe Zeichen.
    schematics: {
      daylight: {
        glassArea: 'Lichteintrittsfläche',
        window: 'Fenster',
        obstruction: 'Lichteinfall 45° — {label}',
        requiredArea:
          'Bodenfläche {floor} m² → erforderliche Lichteintrittsfläche ≥ {required} m² (10 %).',
        obstructionPierces: 'Die Verschattung durchdringt den 45°-Lichteinfallskegel.',
      },
      egress: {
        totalWalkLength: 'Gehweglänge gesamt',
      },
      fireAccess: {
        routeWidth: 'Zufahrt Breite',
        gateClearance: 'Durchfahrt lichte Höhe',
        stagingAreaWidth: 'Aufstellfläche Breite',
        stagingAreaLength: 'Aufstellfläche Länge',
        facadeDistance: 'Abstand zur Fassade',
        walkToEntrance: 'Weg zum Eingang',
        parcel: 'Grundstück {width} × {depth} m',
        route: 'ZUFAHRT',
        building: 'Gebäude',
        stagingArea: 'Aufstellfläche',
        entrance: 'Eingang',
        street: 'STRASSE',
        buildingClass: 'Gebäudeklasse',
        walkTooFar: ' — der Weg zum Eingang überschreitet das zulässige Maß.',
      },
      guardrail: {
        context: {
          balcony: 'Balkon',
          loggia: 'Loggia',
          staircase: 'Stiege',
          window: 'Fenster',
          roof_terrace: 'Dachterrasse',
        },
        elevation: 'ANSICHT · {context}',
        fallHeight: 'Absturzhöhe',
        railHeight: 'Geländerhöhe',
        maxOpening: 'max. Öffnungsweite',
        bottomGap: 'Bodenspalt',
        climbGuard: 'Kletterschutz 15–60 cm',
        atLeast: ' → mind. {value}',
        climbables:
          'Horizontale, zum Aufklettern geeignete Elemente im Kletterschutzbereich (15–60 cm).',
      },
      setback: {
        side: {
          front: 'vorne',
          back: 'hinten',
          left: 'links',
          right: 'rechts',
        },
        distance: 'Abstand {side}',
        parcel: 'Grundstück {width} × {depth} m',
        building: 'Gebäude',
        street: 'STRASSE',
        tooClose: 'Mindestens ein Abstand unterschreitet das geforderte Maß.',
        stated: 'angegeben: {value}',
      },
      stair: {
        section: 'SCHNITT',
        plan: 'GRUNDRISS',
        // Stufennotation, wie sie im Schnitt eines Einreichplans steht.
        stepNotation: '{count} Stg · {rise}/{going} cm',
        // Ohne Steigung und Auftritt bleibt nur die Anzahl.
        stepCount: '{count, plural, one {# Stufe} other {# Stufen}}',
      },
    },
  },
  agentPrompt: {
    plan: {
      points: 'Abschnitte',
      addPoint: 'Abschnitt ergänzen',
      addPlaceholder: 'Weiteren Abschnitt eintragen …',
      removePoint: 'Abschnitt streichen: {point}',
      genre: 'Art des Berichts',
      genres: {
        inspection_report: 'Prüfbericht',
        file_note: 'Aktenvermerk',
        comparison: 'Vergleich',
        checklist: 'Checkliste',
        report: 'Bericht',
      },
      depth: 'Tiefe',
      depths: { quick_check: 'Kurzprüfung', expert_report: 'Gutachten' },
      documents: {
        label: 'Unterlagen',
        basis: 'Vollständig lesen:',
        excluded: 'Ausgeschlossen:',
        none: 'Keine Unterlagen benannt – die Recherche liest, was sie findet.',
        choose: 'Unterlagen wählen',
        removeRead: 'Nicht mehr vollständig lesen: {name}',
        removeExcluded: 'Nicht mehr ausgeschlossen: {name}',
      },
      frame: 'Datengrundlage',
      frameNote: 'Die im Eingabefeld gewählten Quellen. Ändern Sie sie dort, bevor Sie den Plan genehmigen.',
    },
    awaitingOther: 'Piloti wartet auf {name}',
    awaitingSomeone: 'Piloti wartet auf eine andere Person',
    needsInput: 'Piloti benötigt Ihre Eingabe',
    receivedInput: 'Piloti hat Ihre Eingabe erhalten',
    approvePlan: 'Plan genehmigen',
    // The current three-way plan decision (start / answer briefly / cancel).
    startResearch: 'Recherche starten',
    answerShallow: 'Kurz beantworten',
    answerShallowAria: 'Frage kurz beantworten, ohne Deep Research',
    cancelResearch: 'Abbrechen',
    cancelResearchAria: 'Recherche abbrechen',
    selectOption: 'Option auswählen: {option}',
    yourResponse: 'Ihre Antwort:',
    approvalInstructionThreeWay:
      'Starten Sie die Recherche, lassen Sie Ihre Frage stattdessen kurz beantworten, oder brechen Sie ab.',
    durationHint:
      'Die Deep-Research-Ausführung kann mehrere Minuten dauern und verbraucht Kontingent.',
    // The plan bubble's scaffolding, localized in place of the backend's
    // byte-stable English headers.
    planPreviewHeading: 'Rechercheplan',
    planTitleLabel: 'Titel:',
    planSectionsLabel: 'Abschnitte:',
    // What the answered bubble echoes for a clicked decision — the wire
    // keywords (approve/shallow/cancel/reject) never reach the reader.
    responseApproved: 'Recherche gestartet',
    responseShallow: 'Kurze Antwort angefordert',
    responseCancelled: 'Recherche abgebrochen',
    // An answered plan folds to one line; the plan as approved is behind it.
    planRecord: 'Plan freigegeben · {count, plural, one {# Abschnitt} other {# Abschnitte}}',
    showPlan: 'Plan anzeigen',
    hidePlan: 'Plan ausblenden',
  },
  // Die einzelne Aufklappung in der Antwortfußzeile für alles hinter der
  // Quellenzeile und den Kopieraktionen (Konfidenz, Merknotiz, Skills,
  // Prüfhinweise, Bewertung, Zeitstempel).
  // Under an answer the reader stopped, where the writing ended.
  answerStoppedMarker: 'Gestoppt',
  answerDetails: {
    trigger: 'Antwortdetails',
    triggerAria: 'Details zu dieser Antwort anzeigen',
    // The trigger when the details hold a warning (cut-off, salvaged run,
    // stripped citations, low confidence): the dot beside it says so visually.
    triggerAriaAttention: 'Details zu dieser Antwort anzeigen, mit Hinweisen zur Antwort',
    // How long the turn took, question sent to answer final.
    duration: 'Antwort nach {duration}',
    // What the answer cost in the organization's unit: the credits billed for
    // it, or tokens on the organization's own provider key.
    costCredits: '{value} Punkte',
    costTokens: '{value} Tokens',
    costBreakdown: 'Eingabe {prompt} · Ausgabe {completion} · davon Nachdenken {reasoning} Tokens',
    // Gelesen, aber nicht zitiert: was die Recherche sonst noch gelesen hat.
    // Nur Dokument-Chips — keine Stellen, keine neuen Aussagen.
    readSources: {
      label: 'Gelesen, nicht zitiert',
      more: '+{count} weitere',
      less: 'Weniger anzeigen',
    },
  },
  profilePatchCard: {
    accept: 'Übernehmen',
    applying: 'Wird übernommen …',
    reject: 'Ablehnen',
    accepted: 'Projekt-Briefing aktualisiert.',
    rejected: 'Änderungen verworfen.',
    noProject: 'Öffnen Sie diesen Chat aus einem Projekt, um Briefing-Änderungen zu übernehmen.',
    field: 'Feld',
    before: 'Vorher',
    after: 'Nachher',
    applyFailed: 'Änderung konnte nicht übernommen werden',
  },
  memoryProposal: {
    title: 'Diese Erkenntnis merken?',
    prompt: 'Möchten Sie das organisationsweit merken?',
    yes: 'Ja, organisationsweit merken',
    no: 'Nein',
    saving: 'Wird gespeichert …',
    saveToProject: 'Nur in diesem Projekt speichern',
    savedOrg: 'Im Organisationsgedächtnis gespeichert (organisationsweit).',
    savedProject: 'Im Gedächtnis dieses Projekts gespeichert.',
    dismissed: 'Nicht gespeichert.',
    error: 'Erkenntnis konnte nicht gespeichert werden',
    kind: {
      decision: 'Entscheidung',
      constraint: 'Vorgabe',
      open_question: 'Offene Frage',
      derived_fact: 'Abgeleiteter Fakt',
      preference: 'Präferenz',
    },
  },
  thinking: {
    // Eine Zeile je Dokument, das Piloti angesehen hat (ADR-0128); die
    // Vorschaubilder öffnen die Stelle.
    look: {
      place: 'S.\u00A0{page}, {where}',
      placeWhole: 'S.\u00A0{page}',
      // Die Stelle einer Seite in Worten: Das Backend schickt sie deutsch
      // (`page_region_words.py`), hier steht sie in der Sprache der Lesenden.
      region: {
        topLeft: 'oben links',
        topRight: 'oben rechts',
        topCenter: 'oben in der Mitte',
        bottomLeft: 'unten links',
        bottomRight: 'unten rechts',
        bottomCenter: 'unten in der Mitte',
        middleLeft: 'in der Mitte links',
        middleRight: 'in der Mitte rechts',
        pageCenter: 'in der Seitenmitte',
      },
    },
    // Die Arbeitsliste der Herleitung (ADR-0132): eine Zeile je Aufruf, in
    // Runden gruppiert. Die Sätze setzen sich aus den getypten Werten des
    // Aufrufs zusammen, nie aus dem Text des Werkzeugs.
    work: {
      label: 'Arbeitsschritte',
      // Der barrierefreie Name einer Zeile, die ein Dokument öffnet: der Satz der Zeile.
      open: '{target} – öffnen',
      running: 'läuft',
      // Ein Aufruf, unter dem der Zug endete (Stopp, Fehler, Verbindung weg): kein Ergebnis.
      interrupted: 'abgebrochen',
      noHit: 'kein Treffer',
      nothingFound: 'nichts gefunden',
      failed: 'fehlgeschlagen',
      // Hinter „fehlgeschlagen“: was daraus für die Antwort folgt.
      failedNote: 'die Antwort stützt sich nicht darauf',
      // Mehr als fünf Aufrufe in einem Schritt: die schwersten zuerst, der Rest gefaltet.
      more: '+{count} weitere',
      moreAllFound: '+{count} weitere, alle mit Ergebnis',
      fewer: 'Weniger anzeigen',
      // Gleichartige Aufrufe in einer Zeile.
      times: '×{count}',
      // Anführungszeichen in einer Suchanfrage, die selbst in „…“ steht.
      innerQuote: '‚{text}‘',
      // Unter dem Ausschnitt eines Blicks: abgelesen ist keine Messung.
      readOff: 'abgelesen, nicht gemessen',
      // Die Art eines Schritts, aus den Verben seiner Aufrufe.
      kind: {
        search: 'Suchen',
        read: 'Lesen',
        list: 'Ordner öffnen',
        look: 'Betrachten',
        model: 'Modell abfragen',
        workspace: 'Arbeitsbereich',
      },
      shelf: {
        project: 'im Projekt',
        office: 'in der Büroablage',
        base: 'im Basiswissen',
        web: 'im Web',
        session: 'in diesem Chat',
      },
      // Das Verb steht gedämpft vor seinem Gegenstand: „Sucht wörtlich“ „„Brandabschnitt“ im Projekt“.
      verb: {
        search: 'Sucht',
        searchExact: 'Sucht wörtlich',
        searchRegex: 'Sucht nach Muster',
        searchIn: 'Sucht in',
        searchExactIn: 'Sucht wörtlich in',
        searchRegexIn: 'Sucht nach Muster in',
        list: 'Öffnet',
        read: 'Liest',
        look: 'Betrachtet',
        lookup: 'Sucht in anderen Projekten:',
        law: 'Sucht im RIS:',
        web: 'Sucht im Web:',
        model: 'Fragt das Gebäudemodell ab:',
        workspace: 'Arbeitsbereich:',
      },
      // Der Kopf eines fertigen Zugs mit genau einem Aufruf: was getan WURDE.
      done: {
        search: 'Gesucht: {name}',
        list: 'Geöffnet: {name}',
        read: 'Gelesen: {name}',
        look: 'Betrachtet: {name}',
        lookup: 'In anderen Projekten gesucht: {name}',
        law: 'Im RIS gesucht: {name}',
        web: 'Im Web gesucht: {name}',
        model: 'Gebäudemodell abgefragt: {name}',
        workspace: 'Im Arbeitsbereich: {name}',
      },
      doneFallback: {
        search: 'In den Dokumenten gesucht',
        list: 'Einen Ordner geöffnet',
        read: 'Ein Dokument gelesen',
        look: 'Ein Dokument betrachtet',
        lookup: 'In anderen Projekten gesucht',
        law: 'Im RIS gesucht',
        web: 'Im Web gesucht',
        model: 'Gebäudemodell abgefragt',
        workspace: 'Im Arbeitsbereich gearbeitet',
      },
      object: {
        query: '„{query}“',
        queryShelf: '„{query}“ {shelf}',
        queryIn: '{target}: „{query}“',
        pages: '{target}, S.\u00A0{pages}',
        clause: '{target}, {pages}',
        where: '{target}, S.\u00A0{pages}, {where}',
      },
      // Gleichartige Aufrufe in einer Zeile. Suchen tragen kein Verb: „4 Suchen im RIS“.
      many: {
        documents: '{count, plural, one {#\u00A0Dokument} other {#\u00A0Dokumente}}',
        folders: '{count, plural, one {#\u00A0Ordner} other {#\u00A0Ordner}}',
        searches: '{count, plural, one {#\u00A0Suche} other {#\u00A0Suchen}}',
        lawSearches: '{count, plural, one {#\u00A0Suche im RIS} other {#\u00A0Suchen im RIS}}',
        webSearches: '{count, plural, one {#\u00A0Suche im Web} other {#\u00A0Suchen im Web}}',
        lookupSearches:
          '{count, plural, one {#\u00A0Suche in anderen Projekten} other {#\u00A0Suchen in anderen Projekten}}',
        modelQueries:
          '{count, plural, one {#\u00A0Abfrage am Gebäudemodell} other {#\u00A0Abfragen am Gebäudemodell}}',
        workspaceCalls:
          '{count, plural, one {#\u00A0Aufruf im Arbeitsbereich} other {#\u00A0Aufrufe im Arbeitsbereich}}',
      },
      fallback: {
        search: 'Sucht in den Dokumenten',
        list: 'Öffnet einen Ordner',
        read: 'Liest ein Dokument',
        look: 'Betrachtet ein Dokument',
        lookup: 'Sucht in anderen Projekten',
        law: 'Sucht im RIS',
        web: 'Sucht im Web',
        model: 'Fragt das Gebäudemodell ab',
        workspace: 'Arbeitet im Arbeitsbereich',
      },
      found: {
        hits: '{count, plural, one {#\u00A0Treffer} other {#\u00A0Treffer}}',
        hitsDocuments:
          '{hits, plural, one {#\u00A0Treffer} other {#\u00A0Treffer}}\u00A0· {documents, plural, one {#\u00A0Dokument} other {#\u00A0Dokumente}}',
        documents: '{count, plural, one {#\u00A0Dokument} other {#\u00A0Dokumente}}',
        places: '{count, plural, one {#\u00A0Stelle} other {#\u00A0Stellen}}',
        listing:
          '{files, plural, one {#\u00A0Datei} other {#\u00A0Dateien}}, {folders, plural, one {#\u00A0Ordner} other {#\u00A0Ordner}}',
        files: '{count, plural, one {#\u00A0Datei} other {#\u00A0Dateien}}',
        folders: '{count, plural, one {#\u00A0Ordner} other {#\u00A0Ordner}}',
      },
    },
    inProgress: 'Denkvorgang läuft',
    working: 'Antwort wird erstellt …',
    waiting: 'Warten auf Antwort',
    elapsedAria: 'Vergangen: {seconds, plural, one {# Sekunde} other {# Sekunden}}',
    // ── Turn-Events: die Worte zu dem, was das Backend GEMELDET hat ───────
    //
    // Der Agent erzählt sich selbst über `status:<slot>`-Schritte — und zwar in
    // SCHLÜSSELN: eine stabile Punkt-ID plus Interpolationswerte. Alles, was
    // Lesende sehen, steht hier, in ihrer Sprache. Früher stand es im Python
    // und ging als fertiger deutscher Satz über die Leitung — genau so las eine
    // englische Oberfläche Deutsch.
    //
    // Ein Schlüssel ohne Eintrag hier zeigt NICHTS — die Live-Zeile fällt auf
    // die vorige sinnvolle Phrase zurück. Nie den Schlüssel, nie einen
    // internen Bezeichner.
    turnStatus: {
      // Korpus-NAMEN: „im Wissen“ ist Produkttext mit angeschweißter
      // Präposition, kein Eigenname. Das Backend schickt die ID.
      corpus: {
        // Dieselben Worte wie die Zeilen der Herleitung („Sucht in den Dokumenten“).
        knowledge: 'in den Dokumenten',
        ris: 'im RIS',
        web: 'im Web',
        documents: 'in Ihren Unterlagen',
        ifc: 'im Gebäudemodell',
        otherProjects: 'in anderen Projekten',
      },
      // Verbindet zwei Korpora in einer Zeile. Grammatik, also auch hier.
      corpusJoin: ' und ',
      status: {
        // Welche der eigenen Unterlagen gerade gesichtet werden. Ein
        // Schlüssel pro Ebene statt einer Vorlage mit Platzhalter: Deutsch
        // braucht den Dativ („aus der Büroablage“), Englisch gar keinen
        // Artikel, also lässt sich der Name nicht in EINEN Satz einsetzen.
        // Jede Zeile nennt den Namen, den die Lesenden im Produkt sehen —
        // Büroablage, Projekt, Unterhaltung. Für mehrere Ebenen zugleich gibt
        // es keinen: der Sammelbegriff dafür ist unser Wort, nicht ihres, also
        // sagt `several` schlicht, WAS gelesen wird.
        documents: {
          officeShelf: 'Unterlagen aus der Büroablage werden gesichtet …',
          project: 'Unterlagen aus dem Projekt werden gesichtet …',
          session: 'Unterlagen aus diesem Chat werden gesichtet …',
          several: 'Ihre Unterlagen werden gesichtet …',
          // Eine gerade hochgeladene Datei ist noch nicht fertig indiziert;
          // die Antwort wartet kurz darauf, statt ohne sie zu antworten.
          waiting: 'Eine neue Datei wird noch gelesen — die Antwort wartet darauf …',
        },
        // `{query}` sind die eigenen Worte der Lesenden, zurückgespiegelt —
        // nie übersetzt, und vom Backend gekürzt, damit die Zeile passt.
        retrieval: {
          withQuery: 'Sucht {corpus}: „{query}“',
          plain: 'Sucht {corpus} …',
          // Die Fundstelle steht schon fest und wird GELESEN — deshalb nennt
          // die Zeile das Dokument statt eines Korpus. `{document}` ist der
          // Name, den Herausgeber oder Büro vergeben haben: ein Eigenname, der
          // unübersetzt durchgereicht wird.
          clause: 'Liest {document}, Pkt.\u00A0{clause} …',
          page: 'Liest {document}, S.\u00A0{page} …',
          // Es wird mit anderen Formulierungen weitergesucht — die Aktion,
          // nicht das Urteil: Die Zeile sagt, was GERADE geschieht, und sie
          // ersetzt dabei die Suchzeile der Runde, also darf sie nicht mit
          // einem Misserfolg eröffnen. Dass die erste Trefferliste nicht
          // reichte, steht im Schlüssel (`requery`), nicht im Satz. Die
          // Formulierungen selbst sind die des Modells und stehen deshalb
          // nicht in der Zeile.
          requery: 'Sucht mit anderen Begriffen weiter …',
        },
        // Werkzeuge, die keine Recherche sind, aber vom Nutzer gewollt waren.
        // Ein Werkzeug ohne Eintrag bekommt gar keine Zeile: sein interner
        // Name ist kein Status.
        action: {
          remember: 'Notiz wird gespeichert …',
          card: 'Ergebniskarte wird erstellt …',
          // Der Arbeitsordner dieser Unterhaltung: ein Verb, eine Zeile. Kein
          // „sucht“ — hier wird nichts gelesen, was eine Antwort belegen
          // könnte, sondern am Dokument gearbeitet, das gerade entsteht.
          draftList: 'Entwürfe werden durchgesehen …',
          draftRead: 'Entwurf wird gelesen …',
          draftWrite: 'Entwurf wird geschrieben …',
          draftEdit: 'Entwurf wird überarbeitet …',
          // Eine vorgeschlagene Änderung an der Ablage. Kein Verb und kein
          // Dateiname: Die Karte sagt gleich darauf, welcher Vorgang welche
          // Datei betrifft — mit den Schaltflächen daneben.
          fileProposal: 'Vorschlag für Ihre Ablage wird vorbereitet …',
          // Die zwei Schritte, die die Unterhaltung verlassen. Eigene Zeilen,
          // weil sich hier nicht der Entwurf ändert, sondern wo er liegt — und
          // weil Ablegen und Einreichen für die Lesenden zwei verschiedene
          // Dinge sind: das eine legt etwas hin, das andere bittet jemanden.
          draftFiled: 'Entwurf wird im Projekt abgelegt …',
          draftSubmitted: 'Entwurf wird zur Freigabe eingereicht …',
          taskCreated: 'Aufgabe wird angelegt …',
          // Anmerkungen in einem Dokument. Eigene Befunde schlägt Piloti nur
          // vor: Erst eine Person übernimmt oder verwirft sie. Setzen, ändern
          // und löschen tut Piloti nur, worum die Person bittet.
          annotationsRead: 'Anmerkungen werden gelesen …',
          annotationsPropose: 'Anmerkungen werden vorgeschlagen …',
          annotationsSet: 'Anmerkungen werden gesetzt …',
          annotationsUpdate: 'Anmerkung wird geändert …',
          annotationsDelete: 'Anmerkung wird gelöscht …',
          annotationsReply: 'Antwort auf eine Anmerkung wird geschrieben …',
          // Piloti sieht sich eine Seite oder einen Ausschnitt an (ADR-0128).
          look: 'Betrachtet das Dokument …',
          // Ein Aufruf im Arbeitsbereich über Piloti selbst: Lesen läuft,
          // Schreiben kommt als Vorschlag zurück.
          workspaceCall: 'Arbeitet im Arbeitsbereich …',
        },
        // Die Werkzeuge sind durch, die Antwort wird geschrieben. Dieselben
        // Worte wie `activity.composing` darüber: ein Vokabular für dieselbe
        // Sache — ob die Zeile aus einem Turn-Event oder aus der
        // Legacy-Klassifikation kommt, darf man ihr nicht ansehen.
        synthesis: 'Antwort wird formuliert …',
        // Das Vertrauensversprechen des Produkts, laut ausgesprochen: geprüft
        // wird nicht „irgendetwas an den Belegen“, sondern jede Fundstelle
        // gegen das, was tatsächlich abgerufen wurde.
        citations: 'Belege werden gegen die Quellen geprüft …',
        // Ein Zitat steht so in keiner Passage; es wird an Ort und Stelle auf
        // den Wortlaut der zitierten Passage korrigiert (ADR-0067). Keine
        // Nachrecherche, keine Neuformulierung; was nicht korrigiert werden
        // kann, bleibt markiert.
        repair: 'Ein Zitat weicht vom Wortlaut der Quelle ab — wird am Original korrigiert …',
        escalation: 'Kurzrecherche reicht nicht — Tiefenrecherche startet',
        // Eine Ergänzung, die die Person getippt hat, während Piloti
        // arbeitet. `{text}` sind ihre eigenen Worte; `{round}` die Runde,
        // in der Piloti sie gelesen hat.
        steer: {
          received: 'Ergänzt: „{text}“ — wird berücksichtigt …',
          applied: 'Ergänzung übernommen in Runde {round}: „{text}“',
        },
      },
    },
    // Das eine Skill-Ereignis, das Lesende sehen, danach unterschieden, WER
    // entschieden hat. Zwei Sätze statt eines mit getauschtem Verb — dieser
    // Unterschied ist nicht in jeder Sprache ein Wort. `{skill}` ist der vom
    // Büro vergebene `grid-title` und reist unverändert: es ist ihr Name für
    // ihre eigene Arbeitsweise.
    skill: {
      activated: 'Skill „{skill}“ wird angewendet',
    },
    // Kompakte Chips „was tatsächlich gelaufen ist" in der Herleitung-Basis —
    // ein Chip pro ausgeführtem Agenten/Tool, ohne Technik-Opt-in.
    executedSteps: 'Ausgeführt:',
    stepName: {
      webSearch: 'Websuche',
      ris: 'RIS',
      corpus: 'Wissen',
      // In anderen Projekten des Büros nachgeschlagen (ADR-0094), meist in den
      // abgeschlossenen Referenzprojekten.
      otherProjects: 'Andere Projekte',
      reading: 'Lesen',
      // Das Arbeitsverzeichnis der Unterhaltung: schreiben, lesen, ändern,
      // auflisten — ein Wort für alle vier. Was Lesende interessiert, ist dass
      // an einem Entwurf gearbeitet wurde, nicht wie oft.
      draft: 'Entwurf',
      // Der Entwurf verlässt das Arbeitsverzeichnis: als Projektdokument
      // abgelegt oder zur Freigabe eingereicht.
      filing: 'Ablage',
      task: 'Aufgabe',
      // Anmerkungen im Dokument: gelesen, vorgeschlagen oder beantwortet.
      annotations: 'Anmerkungen',
      // Die Dateiaktionen SCHLAGEN vor und schreiben nichts (ADR-0003).
      fileProposal: 'Ablagevorschlag',
      // Gelesen oder vorgeschlagen im Arbeitsbereich (Mitglieder, Freigaben, Aufträge).
      workspace: 'Arbeitsbereich',
      // Ein Chip pro Skill, den dieser Turn tatsächlich angewendet hat.
      // `{name}` liefert die einzige Label-Instanz
      // (features/skills/lib/skill-activity).
      skill: 'Skill: {name}',
      model: 'Gebäudemodell',
      measure: 'Messung',
      drawing: 'Zeichnung',
      documents: 'Dateien',
      note: 'Notiz',
      card: 'Karte',
      compliance: 'Normprüfung',
    },
    // Die Namen im Technik-Panel für die zwei Schrittarten ohne eigenes
    // Werkzeug oder eigenen Slot. Werkzeuge nutzen `stepName.*` oben.
    nodeName: {
      clarification: 'Rückfrage',
      skillSelection: 'Skill-Auswahl',
    },
    interrupted: 'Unterbrochen',
    // Kompakter Inline-Hinweis auf einer unterbrochenen Antwort, statt nur des
    // stummen „Unterbrochen“-Chips. Erst, wenn der Server bestätigt hat, dass er
    // keine Antwort hat und der Zug nicht mehr läuft: vorher ist sie nicht
    // verloren, nur unterwegs. Die Verbindung ist dann nicht die Ursache.
    interruptedNotice: 'Diese Antwort wurde nicht fertig, und auf dem Server liegt keine. Bitte die Frage erneut senden.',
    // Vorübergehender „Wird geprüft“-Zustand (FIX 3): angezeigt, solange der
    // Wiederherstellungs-Abruf nach einer Wiederverbindung läuft, damit ein
    // Zug, der nur unterbrochen AUSSIEHT, nicht sofort den „verloren“-Hinweis
    // zeigt, bevor bestätigt ist, dass die Antwort wirklich fehlt.
    recovering: 'Antwort wird geholt',
    recoveringNotice:
      'Piloti arbeitet weiter — die Antwort erscheint hier, sobald sie fertig ist …',
    done: 'Fertig',
    // Die Lesenden haben die Antwort angehalten: kein grünes Häkchen, kein
    // „Fertig“ — so steht es auch an einem abgebrochenen Lauf.
    stopped: 'Gestoppt',
    // Der Zug hat einen Auftrag angelegt: die Arbeit hat erst begonnen, im
    // Laufblock darunter. Kein grünes Häkchen, kein „Fertig“.
    // Der Zug ist gescheitert; die Fehlerkarte darunter sagt wie.
    failed: 'Fehlgeschlagen',
    handedOff: 'Aufgabe angelegt',
    // Piloti hat die Frage nicht bearbeitet (abgelehnt oder nicht angenommen):
    // das Banner darunter sagt warum. Neutral, kein „Fertig“.
    refused: 'Nicht bearbeitet',
    showThinking: 'Denkschritte anzeigen ({count})',
    showThinkingSteps: 'Denkschritte anzeigen ({count})',
    // Die Kopfzeile der Herleitung. Keine Schrittzahl: gezählt wurden rohe
    // NAT-Ereignisnamen, nicht Züge oder Aufrufe (siehe ChatThinking). Die
    // Quellen-Klausel FEHLT, wenn es keine gibt: „0 Quellen“ ist eine wahre
    // Zahl, die sich wie ein Fehlschlag liest, und eine Antwort aus einer
    // Messung am Modell hat zu Recht keine Zitate.
    // Kopfzeile der Herleitung: Schritte, zitierte Quellen und höchstens EINE Warnung, die schwerste.
    derivationSteps: '{count, plural, one {#\u00A0Schritt} other {#\u00A0Schritte}}',
    derivationCited: '{count, plural, one {#\u00A0Quelle zitiert} other {#\u00A0Quellen zitiert}}',
    derivationWarning: {
      failed: '{count, plural, one {#\u00A0Abruf fehlgeschlagen} other {#\u00A0Abrufe fehlgeschlagen}}',
      open: '{count, plural, one {#\u00A0Punkt offen} other {#\u00A0Punkte offen}}',
    },
    // Ein Zug ohne jede Recherche: eine Zeile, nichts zum Aufklappen.
    noResearch: 'Ohne Recherche beantwortet',
    noResearchNote: 'Allgemeines Fachwissen, keine Quelle zitiert',
    // Ein Zug mit genau einem Aufruf: die Kopfzeile ist die Herleitung.
    singleCited: 'zitiert {markers}',
    derivationSummary: 'Herleitung',
    derivationSummaryWithSources: 'Herleitung\u00A0· {count, plural, one {#\u00A0Quelle} other {#\u00A0Quellen}}',
    // aria-label naming the reasoning graph as one region for screen readers.
    reasoningGraphLabel: 'Herleitung',
    stepsLabel: 'Denkschritte',
    stepsHeading: 'Zwischenschritte',
    sourcesFanOut: 'Quellen',
    hitCount: '{count} Treffer',
    hitCountOne: '1 Treffer',
    gapHit: 'Nicht im Bestand',
    // Ein Dokument, das die Recherche gelesen, die Antwort aber nicht zitiert
    // hat — ein echtes Rechercheergebnis, keine Lücke.
    readNotUsed: 'abgerufen, nicht zitiert',
    moreSources: '+{count} weitere',
    // Einzeiler, wenn dieser Turn von der Kurz- zur Tiefenrecherche eskaliert ist.
    escalationNarration: 'Eskaliert zur Tiefenrecherche: {reason}',
    node: {
      framingTab: 'Einordnung',
      framingTitle: 'Frage verstanden',
      framingQuestion: 'Sie fragen: „{question}“',
      // Die letzte Karte der Herleitung: worauf die Antwort steht, als Entwurf.
      // Nie „nachgewiesen“: Piloti listet die Grundlagen, das Urteil bleibt beim Büro.
      basis: {
        label: 'Grundlagen · Entwurf',
        pendingLabel: 'Grundlagen',
        pending: 'entstehen mit der Antwort',
        law: 'Rechtsgrundlage',
        evidence: 'Belegt durch',
        open: 'Offen',
        clause: 'Pkt.\u00A0{clause}',
        page: 'S.\u00A0{page}',
        // Aus einem Aufruf ohne Treffer: wo gesucht wurde und wonach. Nie „Keine Informationen gefunden“.
        openNoHitIn: 'Nicht beurteilbar, weil die Suche in {target} nach „{query}“ keine Fundstelle ergab.',
        openNoHitShelf: 'Nicht beurteilbar, weil die Suche {shelf} nach „{query}“ keine Fundstelle ergab.',
        openNoHit: 'Nicht beurteilbar, weil die Suche nach „{query}“ keine Fundstelle ergab.',
        openEmpty: 'Nicht beurteilbar, weil ein Aufruf nichts ergab: {what}.',
        // Aus einem fehlgeschlagenen oder abgebrochenen Aufruf: der Aufruf als Hauptwort.
        openFailed: 'Nicht beurteilbar, weil {call} fehlgeschlagen ist.',
        openInterrupted: 'Nicht beurteilbar, weil {call} abgebrochen wurde.',
        callQuery: '{call} nach „{query}“',
        callTarget: '{call} „{target}“',
        call: {
          search: 'die Suche',
          list: 'das Öffnen des Ordners',
          read: 'das Lesen des Dokuments',
          look: 'das Betrachten des Dokuments',
          lookup: 'die Suche in anderen Projekten',
          law: 'die Abfrage im RIS',
          web: 'die Suche im Web',
          model: 'die Abfrage des Gebäudemodells',
          workspace: 'ein Aufruf im Arbeitsbereich',
        },
      },
      cardLink: 'Aufrufe zu {name} hervorheben',
      // Die nicht zitierten Quellen eines Schritts, in einer gestrichelten Karte.
      // Solange die Antwort läuft, weiß niemand, was sie zitiert: dann „weitere“.
      uncited: {
        pill: 'Nicht zitiert',
        pillLive: 'Abgerufen',
        name: '+{count} abgerufen',
        nameLive: '+{count} weitere',
        hide: 'Nicht zitierte Quellen ausblenden',
      },
      // Jede Abrufschicht auf der Herleitungs-Achse, in Ausführungsreihenfolge:
      // ein Zähler, ein Wort. Die alte Zwei-Wort-Folge (`Suche 1`, dann
      // `Folgerung 2…`) las sich als ein Lauf, zählte aber zwei Dinge — die
      // Werkzeugaufrufe und die Schlussfolgerungen —, sodass die Nummern eine
      // Schicht doppelt belegen konnten. WAS die Schicht getan hat, steht als
      // typisierte Unterzeile dabei, nie als Nummer.
      stepTab: 'Schritt {n}',
      // Die typisierte Unterzeile neben `stepTab`: was diese Schicht getan
      // hat, aus Folgerung × Dateien der Runde gelesen, die die Achse ohnehin
      // besitzt. Eine Schicht, die auf Grundlage des Abgerufenen folgert, ist
      // ein Befund; ein nackter Abruf ohne Treffer ist eine Suche. `Lesen`
      // übernimmt bewusst das Wort von `stepName.reading`: ein Vokabular,
      // nicht zwei.
      stepKindSearch: 'Suche',
      stepKindRead: 'Lesen',
      stepKindFinding: 'Befund',
      stepKindConclusion: 'Schluss',
      // Ein Abruf, den das Backend gesehen hat und der nichts zurückgab. Nicht
      // „Suche": eine Schicht ohne Fächer las sich wie eine, die nichts
      // fand, und war oft nur eine, deren Treffer der alte Draht nie stempelte.
      // Erst das Ledger macht den Unterschied benennbar.
      stepKindNoHits: 'Kein Treffer',
      // Eine Runde, die nur Ordner geöffnet hat: sie sucht keine Dokumente, also
      // ist leer ausgehen kein Fehlschlag (ADR-0132).
      stepKindBrowse: 'Ordner öffnen',
      // Eine Schicht, die ausschließlich Passagen bereits gefundener Dateien
      // aufgeschlagen hat: sie hat nichts Neues gesucht. Genau diese Runde von
      // einem frischen Abruf zu unterscheiden, ist der Sinn des Wortes.
      stepKindOpen: 'Öffnen',
      // Zugeklappte Schicht: die Spur ihres Fächers — Anzahl plus oberste
      // Dateinamen, nie eine nackte Zahl. Eine Zahl allein liest sich als
      // „kein Beleg“. Weiterhin nie die Suchanfrage (PF-12).
      roundFoldOne: '{name} · {locus}',
      roundFoldOneBare: '{name}',
      roundFoldTwo: '{first} · {second}',
      roundFoldMany: '{count} Dateien · {first} u.a.',
      // Die Fundstellen-Hälfte von `roundFoldOne`, in den Worten der Antwort
      // (vgl. `answerSources.punktPage`): die Stelle, nicht der Mechanismus.
      roundFoldLocusPage: 'S.\u00A0{page}',
      roundFoldLocusClause: 'Pkt.\u00A0{clause}',
      roundFoldLocusClausePage: 'Pkt.\u00A0{clause}\u00A0· S.\u00A0{page}',
      // Barrierefreier Name der Schaltfläche, die die Schicht auf- und zuklappt.
      // Der Kartentext selbst ist eine Folgerung und taugt nicht als Name.
      roundFold: 'Schritt {n} zuklappen',
      roundUnfold: 'Schritt {n} aufklappen',
      // Eine Datei, die eine frühere Runde schon gezeigt hat, steht an der
      // Stelle der Trefferzahl. Die Zahl ist die Bilanz des ganzen Turns und
      // damit bei jeder Wiederholung dieselbe — genau das ließ ein erneutes
      // Aufschlagen wie einen zweiten Abruf aussehen.
      roundDocRepeat: 'bereits abgerufen',
      workspaceRead: 'Aus dem Arbeitsbereich gelesen',
      contextLabel: 'Kontext',
      sourcesTab: 'Quellen',
      sourcesTitle: 'Geprüfte Quellen',
      // Die Recherche lief nicht zu Ende, sondern gegen ihre Iterationsgrenze.
      // Im Stand-Knoten, weil er die Frage „was lag der Antwort
      // zugrunde?“ beantwortet — und dazu gehört, wo die Kette abbrach.
      // {tool} ist der zuletzt AUSGEFÜHRTE Schritt, nicht der nächste: welchen
      // das Modell als Nächstes gewählt hätte, weiß niemand — es kam nicht mehr
      // dazu, ihn vorzuschlagen.
      findingsTruncatedStep: 'Recherche hier beendet — zuletzt gelaufen: {tool}',
      // Wenn kein Schritt zu benennen ist (das Budget war vor dem ersten
      // Werkzeug erschöpft): lieber weniger sagen als etwas erfinden.
      findingsTruncated: 'Recherche hier beendet: das Budget war aufgebraucht',
      // ── Was die Antwort NICHT ist ───────────────────────────────────────
      //
      // Zwei Aufzeichnungen, die die Tiefenrecherche über ihre eigenen Grenzen
      // führt — beide auf dem technischen Kanal, beide bislang unsichtbar: ein
      // Lauf, der in die Zeit- oder Schrittgrenze lief, und eine Antwort, die
      // erkennbar schwächer ausgeliefert wurde. Bis sie hier standen, sah eine
      // nach zwei von zehn geplanten Suchen abgebrochene Antwort genauso aus
      // wie eine vollständige.
      //
      // Formuliert als Aussagen, mit denen Planende etwas anfangen können, nie
      // als die Telemetrie, aus der sie stammen. Die Aufzeichnung führt auch
      // die Berichtslänge in Zeichen mit; dafür gibt es bewusst keine Zeile —
      // eine Zeichenzahl benennt einen Mechanismus, sonst nichts.
      limits: {
        label: 'Einschränkungen',
        deepCutoff: {
          // Woran der Lauf endete. `other` deckt einen Grund ab, den dieser
          // Build nicht kennt — DASS vorzeitig Schluss war, stimmt in jedem Fall.
          time: 'Die Tiefenrecherche erreichte die Zeitgrenze.',
          steps: 'Die Tiefenrecherche erreichte ihre Schrittgrenze.',
          other: 'Die Tiefenrecherche wurde vorzeitig beendet.',
          // …und ob etwas davon zu retten war. Diese Hälfte entscheidet, wie
          // viel Gewicht die Antwort darüber tragen kann.
          salvaged: 'Was bis dahin belegt war, ist in die Antwort eingegangen.',
          nothing: 'Ergebnisse lagen zu diesem Zeitpunkt keine vor.',
          // Wie weit sie kam. Nur genannt, wenn es etwas zu nennen gibt: null
          // Quellen ist eine wahre Zahl, die sich wie ein Urteil liest — und
          // `nothing` oben sagt bereits die ehrliche Fassung davon.
          sources:
            '{count, plural, one {# Quelle war bis dahin gesichtet} other {# Quellen waren bis dahin gesichtet}}.',
          after: 'Abbruch nach {minutes, plural, one {# Minute} other {# Minuten}}.',
        },
        // Die Antwort ging schwächer raus als ein sauberer Lauf. Diese Zeilen
        // sind der Hinweis, vor dem Verlassen darauf selbst nachzusehen.
        degraded: {
          noReport:
            'Es wurde kein Recherchebericht abgelegt — die Antwort steht nur hier im Verlauf.',
          noCitations:
            'Keine Belegstelle hielt der Prüfung stand. Bitte schlagen Sie die Angaben vor der Verwendung selbst nach.',
          noCards:
            'Der Bericht ist vollständig, aber die daraus abgeleiteten Vorschläge konnten nicht erzeugt werden.',
          basisUnread:
            'Nicht alle als Grundlage benannten Unterlagen konnten gelesen werden; ihr Inhalt ist in der Antwort nicht berücksichtigt. Welche es sind, steht am Ende des Berichts.',
        },
      },
      branchesTab: 'Folgewege',
    },
  },
  error: {
    showDetails: 'Details anzeigen',
    hideDetails: 'Details ausblenden',
    // Wiederholaktion bei einer fehlgeschlagenen Antwort (Designsprache:
    // „hilfreiche Meldung + erneut versuchen“).
    retry: 'Erneut versuchen',
    // Die Kennung der fehlgeschlagenen Anfrage. Angezeigt werden die ersten
    // acht Zeichen – genau die, die im Log stehen –, kopiert wird die ganze.
    reference: 'Referenz für den Support',
    referenceCopyAria: 'Referenz {id} kopieren',
    referenceCopied: 'Referenz kopiert',
  },
  errorRegistry: {
    connectionLost: {
      title: 'Verbindung getrennt',
      message: 'Die Verbindung zum Server wurde getrennt. Bitte überprüfen Sie Ihr Netzwerk.',
    },
    connectionFailed: {
      title: 'Verbindung fehlgeschlagen',
      message: 'Verbindung zum Server nicht möglich. Bitte überprüfen Sie Ihre Netzwerkverbindung.',
    },
    clientOutdated: {
      title: 'Piloti wurde aktualisiert',
      message: 'Laden Sie die Seite neu, um weiterzuarbeiten.',
    },
    serverIncompatible: {
      title: 'Piloti ist gerade nicht erreichbar',
      message:
        'Der Server läuft mit einer anderen Version als diese Seite – das kommt während eines Updates kurz vor. Versuchen Sie es in einigen Minuten erneut; hält es an, melden Sie es dem Support.',
    },
    connectionTimeout: {
      title: 'Zeitüberschreitung der Anfrage',
      message: 'Die Anfrage hat zu lange gedauert.',
    },
    sessionExpired: {
      title: 'Sitzung abgelaufen',
      message: 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',
    },
    unauthorized: {
      title: 'Nicht autorisiert',
      message: 'Sie haben keine Berechtigung, diese Aktion auszuführen.',
    },
    responseFailed: {
      title: 'Antwort fehlgeschlagen',
      message: 'Beim Erstellen einer Antwort ist beim Assistenten ein Fehler aufgetreten.',
    },
    // Erst, wenn der Server bestätigt hat, dass er keine Antwort hat.
    responseInterrupted: {
      title: 'Antwort unterbrochen',
      message:
        'Piloti hat diese Antwort nicht abgeschlossen, und auf dem Server liegt keine. Bitte senden Sie die Frage erneut.',
    },
    noResponse: {
      title: 'Keine Rückmeldung',
      message: 'Piloti hat auf Ihre Frage nicht reagiert, auch nicht auf einen zweiten Versuch. Senden Sie sie erneut.',
    },
    zdrRefused: {
      title: 'Modell unter Zero Data Retention nicht verfügbar',
      message:
        'Die Zero-Data-Retention-Einstellung Ihrer Organisation erlaubt nur Modelle mit einem Zero-Data-Retention-Endpunkt, und das Modell für diese Aufgabe hat keinen. Eine Administratorin oder ein Administrator der Organisation muss unter Organisation → Modelle ein solches Modell wählen.',
    },
    workflowError: {
      title: 'Anfrage fehlgeschlagen',
      message:
        'Beim Bearbeiten Ihrer Anfrage ist beim Assistenten ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.',
    },
    unknown: {
      title: 'Etwas ist schiefgelaufen',
      message: 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.',
    },
    // Deep-Research-Auftrag wurde abgelehnt, weil die Warteschlange voll ist
    // (WP-A `job_admission_rejected`). Warnung, nicht Fehler: erneut senden hilft.
    researchQueueFull: {
      title: 'Recherche ausgelastet',
      full: 'Die Recherche-Warteschlange ist gerade voll.',
      message:
        'Die Recherche-Warteschlange ist gerade voll. Bitte senden Sie Ihre Anfrage in einem Moment erneut.',
      retryHint:
        'Bitte in etwa {seconds, plural, one {# Sekunde} other {# Sekunden}} erneut senden.',
    },
  },
  budgetExhausted: {
    title: 'Budget aufgebraucht',
    memberMessage:
      'Ihr Nutzungsbudget ist aufgebraucht, daher können derzeit keine neuen Nachrichten gesendet werden. Ihren eigenen Verbrauch finden Sie unter Organisation → Verbrauch & Budgets. Bitten Sie eine Organisations-Administratorin oder einen -Administrator, Ihr Limit zu erhöhen.',
    adminMessage:
      'Das Nutzungsbudget ist aufgebraucht, daher können derzeit keine neuen Nachrichten gesendet werden. Erhöhen Sie die Limits unter Organisation → Verbrauch & Budgets.',
  },
  /**
   * Der Verbrauchshinweis über dem Eingabefeld (`UsageNotice.tsx`). `{budget}`
   * ist eine der `budget.*`-Wendungen und steht immer am Satzanfang.
   */
  usageNotice: {
    budget: {
      organization: { day: 'Das Tagesbudget des Büros', month: 'Das Monatsbudget des Büros' },
      member: { day: 'Ihr persönliches Tagesbudget', month: 'Ihr persönliches Monatsbudget' },
      project: { day: 'Das Tagesbudget dieses Projekts', month: 'Das Monatsbudget dieses Projekts' },
    },
    title: {
      forecast: '{budget} reicht bei diesem Tempo nur bis etwa {date}',
      warning: '{budget} ist zu {percent} verbraucht',
      critical: '{budget} ist fast aufgebraucht ({percent})',
      exhausted: '{budget} ist aufgebraucht',
    },
    usedSoFar: 'Bisher {percent} verbraucht.',
    amountsCredits: '{used} von {limit} Punkten.',
    amountsTokens: '{used} von {limit} Tokens.',
    paceRunsOut: 'Bei diesem Tempo reicht es bis etwa {date}.',
    longRunsMayStop: 'Eine längere Recherche kann vor ihrem Ende abbrechen.',
    renewsDay: 'Es erneuert sich um {time} Uhr.',
    renewsMonth: 'Es erneuert sich am {date}.',
    blockedDay: 'Bis es sich um {time} Uhr erneuert, können keine neuen Nachrichten gesendet werden.',
    blockedMonth: 'Bis es sich am {date} erneuert, können keine neuen Nachrichten gesendet werden.',
    askAdmin: 'Eine Administratorin oder ein Administrator kann das Limit erhöhen.',
    raiseLimit: 'Limit erhöhen',
    seeUsage: 'Verbrauch ansehen',
    meterLabel: '{percent} des Budgets verbraucht',
  },
  noSources: {
    warning:
      'Keine Datenquellen ausgewählt und keine Dateien verfügbar. Antworten sind eher ungenau oder veraltet, sofern keine externen Datenquellen hinzugefügt werden.',
  },
  memory: {
    noted: 'Piloti hat sich gemerkt',
    notedAria: 'Piloti hat sich {count, plural, one {# Notiz} other {# Notizen}} gemerkt',
    addedToMemory: 'In das Projektgedächtnis aufgenommen',
    manageHint: 'Diese Einträge können Sie im Projektgedächtnis verwalten und löschen.',
    kinds: {
      decision: 'Entscheidung',
      constraint: 'Vorgabe',
      open_question: 'Offene Frage',
      derived_fact: 'Fakt',
      preference: 'Präferenz',
    },
    provenance: {
      distillation: 'nach der Antwort ergänzt',
      inTurn: 'während der Antwort notiert',
    },
  },
  confidence: {
    label: 'Einschätzung: {level}',
    levels: {
      high: 'hoch',
      medium: 'mittel',
      low: 'niedrig',
    },
    ariaLabel: 'Selbsteinschätzung des Assistenten: {level}',
    tooltip:
      'Die eigene Einschätzung des Assistenten, wie gut diese Antwort durch seine Quellen gestützt ist. Sie kann falsch sein.',
    // Was jede Stufe BEDEUTET — im Tooltip gezeigt, damit der Leser den Chip einordnen kann.
    levelMeanings: {
      high: 'Hoch: die Antwort ist direkt durch die abgerufenen Quellen belegt, die sie klar und konsistent stützen.',
      medium:
        'Mittel: teilweise belegt — Quellen stützen Teile, aber eine Lücke, eine Schlussfolgerung oder eine kleine Mehrdeutigkeit bleibt.',
      low: 'Niedrig: Quellen fehlen, widersprechen sich oder reichen nicht aus; die Antwort extrapoliert aus Allgemeinwissen.',
    },
    // Label vor der eigenen Kurzbegründung des Modells (wortgetreu).
    reasonLabel: 'Begründung des Assistenten',
    // Dasselbe Label, wenn die Einschätzung danach gedeckelt wurde: die
    // Begründung beschreibt die Stufe VOR der Begrenzung, nicht die gezeigte.
    reasonLabelBeforeCap: 'Begründung des Assistenten vor der Begrenzung',
    // Zusatzsatz, der im Tooltip erklärt, WARUM die Einschätzung gedeckelt
    // wurde, je nach `answer_confidence_capped_reason` (WP-A, PB-9).
    cappedReasons: {
      ungrounded: 'Geringe Sicherheit: Antwort nicht durch Quellen belegt.',
      quoteUnverified:
        'Ein Zitat konnte nicht wörtlich in der Quelle bestätigt werden; die Einschätzung ist entsprechend begrenzt.',
      // Die Messung belegt die Zahl, nicht die Rechtsaussage daneben — deshalb
      // bleibt die gemischte Antwort auf „gering", und der Tooltip sagt warum.
      normativeClaimUncited:
        'Geringe Sicherheit: die Maße stammen aus dem Modell, die normative Aussage dazu ist aber nicht durch eine Quelle belegt.',
      // Gemessen ist nicht zitiert: die Zahl ist nachvollziehbar, „hoch" bleibt
      // aber der Antwort mit geprüfter Quellenangabe vorbehalten.
      measurementOnly:
        'Mittlere Sicherheit: die Angabe ist am Modell gemessen (mit Toleranz und Methode), aber nicht durch eine Quelle belegt.',
      // Die Quelle stammt aus dem Gespräch, nicht aus dieser Antwort — sie
      // belegt daher nur so viel wie eine Messung.
      citationFallback:
        'Mittlere Sicherheit: die angeführte Quelle wurde ergänzt, nicht von der Antwort selbst zitiert.',
    },
    // Die Einschätzung seit ADR-0125: pro Aussage gerechnet, nicht pro Antwort.
    // Ältere Antworten behalten die Texte oben, unter denen sie berechnet wurden.
    byClaim: {
      tooltip:
        'Die eigene Einschätzung des Assistenten, begrenzt durch die schwächste tragende Aussage der Antwort. Sie kann falsch sein.',
      levelMeanings: {
        high: 'Hoch: jede tragende Aussage ist belegt, durch eine zitierte Quelle, einen Eintrag im Arbeitsbereich oder eine Messung.',
        medium:
          'Mittel: eine tragende Aussage ist eine Einschätzung oder allgemeines Wissen, oder ein gelesener Eintrag deckt eine Zahl nicht.',
        low: 'Niedrig: eine Aussage zu Recht, Zahl oder Frist ist nicht belegt, oder eine Quellenangabe hielt der Prüfung nicht stand.',
      },
      // Woraus die Sätze der Antwort bestehen, in Lesereihenfolge: was hält zuerst.
      mix: {
        supported: '{count, plural, one {# Aussage belegt} other {# Aussagen belegt}}',
        observed: '{count, plural, one {# Aussage von der Zeichnung abgelesen} other {# Aussagen von der Zeichnung abgelesen}}',
        reasoning: '{count, plural, one {# Einschätzung} other {# Einschätzungen}}',
        modelKnowledge: '{count, plural, one {# Aussage aus allgemeinem Wissen} other {# Aussagen aus allgemeinem Wissen}}',
        normativeUncited: '{count, plural, one {# Rechtsaussage ohne Beleg} other {# Rechtsaussagen ohne Beleg}}',
        dropped: '{count, plural, one {# Beleg nicht verifiziert} other {# Belege nicht verifiziert}}',
      },
      cappedReasons: {
        ungrounded: 'Begrenzt durch eine tragende Aussage, hinter der kein Beleg steht.',
        quoteUnverified:
          'Ein Zitat konnte nicht wörtlich in der Quelle bestätigt werden; die Einschätzung ist entsprechend begrenzt.',
        // Ein Eintrag im Arbeitsbereich oder eine Messung belegt Fakten über
        // das Büro und das Gebäude, nie eine Aussage über das Recht.
        normativeClaimUncited:
          'Begrenzt durch eine Rechtsaussage ohne zitierte Quelle. Ein Eintrag im Arbeitsbereich oder eine Messung belegt keine Rechtsaussage.',
        measurementOnly:
          'Mittlere Sicherheit: die Angabe ist am Modell gemessen (mit Toleranz und Methode), aber nicht durch eine Quelle belegt.',
        citationFallback:
          'Mittlere Sicherheit: die angeführte Quelle wurde ergänzt, nicht von der Antwort selbst zitiert.',
      },
    },
  },
  // Antwort-Feedback per Daumen (WS-7).
  feedback: {
    question: 'War das hilfreich?',
    helpfulAria: 'Diese Antwort als hilfreich markieren',
    notHelpfulAria: 'Diese Antwort als nicht hilfreich markieren',
    reasonPrompt: 'Was war das Problem?',
    reasons: {
      inaccurate: 'Ungenau',
      too_slow: 'Zu langsam',
      wrong_source: 'Falsche Quelle',
      other: 'Sonstiges',
    },
    thanks: 'Danke für Ihr Feedback.',
    // States what the press COMMITTED rather than thanking: the vote is
    // persisted on the press, so the reason and note are a second, optional
    // act, and "danke" beside an open "Was war das Problem?" reads as if
    // the exchange were already over.
    voteRecorded: 'Bewertung gespeichert.',
    commentLabel: 'Noch etwas?',
    commentPlaceholder: 'Optional — was ist schiefgelaufen?',
    expectedLabel: 'Was hätte in einer guten Antwort stehen sollen?',
    expectedPlaceholder: 'z. B. Brüstungshöhe 1,00 m laut OIB-RL 4',
    commentSubmit: 'Hinweis senden',
  },
  // Nach einem Daumen nach unten: dieselbe Frage mit mehr Aufwand erneut stellen.
  retryThorough: {
    action: 'Gründlicher neu beantworten',
    aria: 'Dieselbe Frage mit höherem Aufwand erneut beantworten lassen',
  },
  // Schaltfläche „Nachricht kopieren" auf den Nutzernachrichtenblasen
  copyMessage: {
    copy: 'Nachricht kopieren',
    copied: 'Kopiert',
    failed: 'Nachricht konnte nicht kopiert werden',
  },
  /**
   * Sensible Daten im Chat (ADR-0086): was der Composer vor dem Senden meldet.
   * Die Platzhalter selbst sind Fachdaten und kommen aus `content-screen.ts`.
   */
  /** The notice once a chat's answers drew on another project (ADR-0094). */
  otherProjects: {
    chip: '{count, plural, one {Ein anderes Projekt} other {# andere Projekte}}',
    title: 'Dieser Chat stützt sich auf andere Projekte: {projects}.',
    gone: 'ein Projekt, das es nicht mehr gibt',
    body: 'Er lässt sich nur mit Personen teilen, die diese Projekte öffnen dürfen. Aus ihm geht nichts ins Projektgedächtnis, in Aufgaben, in eine Tiefenrecherche oder in die Projektablage.',
  },
  screening: {
    title: 'Enthält {items} (Sensible Daten).',
    body: 'Piloti sendet sie nicht an das Antwortmodell.',
    preview: 'Das Modell sieht: „{text}“',
    iban: '{count, plural, one {eine IBAN} other {# IBANs}}',
    at_svnr:
      '{count, plural, one {eine Sozialversicherungsnummer} other {# Sozialversicherungsnummern}}',
    credit_card: '{count, plural, one {eine Kartennummer} other {# Kartennummern}}',
    term: 'den Begriff „{term}“',
    withSample: '{item} {sample}',
    sendMasked: 'Maskiert senden',
    edit: 'Bearbeiten',
  },
}
