import type { en } from '../en'

/** chat namespace — populated during component i18n. */
export const chat: typeof en.chat = {
  actions: {
    dismiss: 'Schließen',
  },
  sourcePreview: {
    chipAria: 'Quelle ansehen: {label}',
    view: 'Ansehen',
    projectDocument: 'Projektunterlage',
    corpusDocument: 'Baurecht & Richtlinien',
    citedPassage: 'Fundstelle',
    cited: 'Zitiert',
    loadFailed: 'Die Quellenvorschau konnte nicht geladen werden. Bitte versuchen Sie es erneut.',
    bindingLabel: 'Bindungswirkung',
    // Coarse binding classification beside the tier badge. `unbekannt` has no
    // entry on purpose — an unclassified source shows no pill at all.
    binding: {
      bindend: 'Bindend',
      verbindlich_erklaert: 'Verbindlich erklärt',
      auslegend: 'Auslegend',
    },
    openExternal: 'Im RIS öffnen',
    // Coarse source kind (ADR-0026) shown in the info popover. Preferred
    // over `origins` because the origin token is kb/ris/web only, so a
    // knowledge-base copy of a legal text reads as project material.
    kinds: {
      baurecht: 'Baurecht & Richtlinien',
      buero: 'Büroarchiv',
      projekt: 'Projektwissen',
      web: 'Webquelle',
    },
    origins: {
      kb: 'Projektwissen',
      ris: 'Recht & Richtlinien (RIS)',
      web: 'Webquelle',
    },
  },
  // Dokumentraster: echte Projekt-/Büroarchiv-Dateien, die der Assistent als
  // anklickbare Vorschaukarten anzeigt (`document_grid`-Karte / `surface_documents`).
  documentGrid: {
    countOne: '1 Dokument',
    countOther: '{count} Dokumente',
    forQuery: '„{query}“',
    source: {
      projekt: 'Projekt',
      buero: 'Büro',
    },
    // Eine referenzierte Datei, die sich nicht mehr auf eine Dokumentzeile
    // auflösen lässt — eine ehrliche, handlungsfähige Karte (im Archiv / in den
    // Projektdateien öffnen) statt einer stummen toten Kachel.
    unresolvedHint: 'Der Assistent hat diese Datei referenziert.',
    openInArchive: 'Im Archiv öffnen',
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
  composer: {
    placeholder: 'Fragen Sie Piloti zu diesem Projekt …',
    sources: 'Datengrundlage',
    sourcesAria: 'Datengrundlage – {enabled} von {total} Quellen aktiv. Öffnet die Datenquellen.',
    deepResearch: 'Deep Research',
    deepResearchAria: 'Deep-Research-Präferenz',
    deepResearchHint:
      'Präferenz vermerkt – Piloti eskaliert automatisch zu Deep Research, wenn eine Frage es erfordert.',
    scopeAria: 'Suchbereich: {project}',
    scopeFallback: 'Dieses Projekt',
    scopeCurrent: 'Aktuelles Projekt',
    scopeAll: 'Alle Projekte',
    scopeAllSoon: 'Bald verfügbar – projektübergreifende Suche ist noch nicht möglich.',
    // Mobile-only cue: the source/scope labels collapse to icons on phones, so a
    // tiny one-line hint under the composer keeps the active source count legible.
    sourcesActiveMobile: '{count, plural, one {# Quelle} other {# Quellen}} aktiv',
  },
  shortcuts: {
    label: 'Schnellzugriff',
    presetAria: 'Quellen-Voreinstellung: {label}',
    presets: {
      law: 'Baurecht & Richtlinien',
      project: 'Projektunterlagen',
      office: 'Büroarchiv',
    },
  },
  greeting: {
    morning: 'Guten Morgen',
    afternoon: 'Guten Tag',
    evening: 'Guten Abend',
    withName: '{greeting}, {name}.',
    subtitle: 'Fragen Sie zu Ihrem Projekt – Antworten belegen ihre Quellen.',
  },
  // Beispielhafte österreichische Baurecht-Fragen im leeren Chat — ein Klick
  // füllt den Verfasser vor (sendet nicht automatisch), gegen die Blockade des
  // leeren Blatts.
  examples: {
    label: 'Zum Beispiel',
    questions: {
      modelElements: 'Wie viele Außenwände hat das Erdgeschoß?',
      modelRequirements: 'Welche Anforderungen kann mein Modell noch nicht beantworten?',
      fluchtweg: 'Fluchtweglänge nach OIB-2?',
      barrierefreiheit: 'Barrierefreiheit Wohnbau Wien?',
      brandabschnitte: 'Brandabschnitte Gebäudeklasse 4?',
    },
  },
  // Empty-state lock chip + thread role tabs (click-dummy overhaul, WS-3).
  workspace: {
    private: 'Privater Arbeitsbereich',
  },
  roles: {
    input: 'Eingabe',
    result: 'Ergebnis',
    // Rollen-Tab für eine konversationelle / klärende Antwort (routing_decision
    // = 'meta': Begrüßungen, Fähigkeits- und Rückfragen) — deutlich abgesetzt
    // von einem inhaltlichen Baurecht-'Ergebnis'.
    note: 'Hinweis',
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
  },
  // Der Zitat-Peek: was diese Fundstelle IST, bevor man sie öffnet.
  citationPeek: {
    wholeDocument: 'Gesamtes Dokument',
    openAtPage: 'An dieser Stelle öffnen',
    copyLink: 'Link kopieren',
    copyLinkAria: 'Link zu dieser Fundstelle kopieren: {label}',
    markerAria: 'Quelle {number}: {label} — Vorschau öffnen',
    lociLabel: '{count, plural, one {# Fundstelle} other {# Fundstellen}}',
    lociAria: 'Fundstellen in diesem Dokument',
    lociPosition: '{index}/{count}',
    previousLocus: 'Vorherige Fundstelle',
    nextLocus: 'Nächste Fundstelle',
    retrievedOnly: 'Gelesen',
  },
  breadcrumb: {
    ariaLabel: 'Navigationspfad',
    renameAria: 'Sitzung umbenennen – zum Bearbeiten klicken',
    renameInputAria: 'Sitzungstitel',
  },
  cards: {
    aiGenerated:
      'KI-generierte Zitierung — prüfen Sie den Auszug anhand der Primärquelle (OIB / RIS).',
    legalBasis: 'Rechtsgrundlage',
    viewOib: 'OIB-Richtlinie ansehen',
    verifyRis: 'In RIS prüfen',
    conditionTree: {
      eyebrow: 'Bedingungsbaum',
      dependsOn: 'Abhängig von',
      applies: 'trifft zu',
      basis: 'Grundlage',
      // Überschrift über dem Ergebnis des Falls, der für dieses Projekt gilt.
      appliesHere: 'Für dieses Projekt gilt:',
      // Überschrift über jedem anderen Fall — im Konjunktiv, damit schon die
      // Grammatik sagt, dass hier ein anderer Fall angesehen wird. Ein
      // Bildschirmfoto dieses Abschnitts kann so nicht als Ergebnis dieses
      // Projekts gelesen werden.
      previewLead: 'Bei {condition} würde gelten:',
      // Dieselbe Überschrift, wenn kein Fall als der zutreffende ausgewiesen
      // ist: dann steht nichts dagegen, was in den Konjunktiv zu setzen wäre.
      caseLead: 'Bei {condition} gilt:',
      // Steht INNERHALB des angesehenen Abschnitts, damit der Hinweis auf
      // jedem Bildschirmfoto mitgeht.
      previewNotice: 'Nur zum Vergleich — für dieses Projekt gilt {condition}: {outcome}',
      backToActive: 'Zurück zu {condition}',
      caseAria: 'Fall {condition}',
    },
    askAbout: {
      chip: 'Dazu fragen',
      chipAria: 'Frage zu „{subject}“ ins Eingabefeld übernehmen',
      missingWithDetail:
        'Bei „{subject}“ fehlt eine Angabe: {missing}. Wie kann ich das nachreichen, und was gilt bis dahin?',
      missingOnly:
        'Bei „{subject}“ fehlt eine Angabe. Welche Angabe wird dafür benötigt, und woher bekomme ich sie?',
    },

    // ── Gemeinsame Schematik-Chrome ────────────────────────────────────────
    // `kit.tsx` zeichnet fünfzehn Karten. Sein Wortschatz steht hier, weil er
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
    },
    keyTakeaways: {
      eyebrow: 'Das Wichtigste',
    },
    callout: {
      hinweis: 'Hinweis',
      achtung: 'Achtung',
      frist: 'Frist',
      tipp: 'Tipp',
      more: 'Mehr dazu',
      less: 'Weniger',
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
      computedNote: 'Das Ergebnis wird von dieser Karte aus den obigen Werten berechnet, nicht aus der Antwort übernommen.',
    },
    processMap: {
      eyebrow: 'Verfahrensablauf',
      current: 'hier stehen Sie',
      done: 'erledigt',
      stepAria: 'Schritt {step}: {label}',
      requires: 'Voraussetzungen',
      produces: 'Ergebnis',
      actor: 'Zuständig',
      duration: 'Frist',
      basis: 'Grundlage',
      // Steht INNERHALB eines geöffneten anderen Schritts, damit der Hinweis
      // auf einem Bildschirmfoto genau dieses Abschnitts mitgeht.
      elsewhereNotice: 'Nur zur Ansicht — dieses Projekt steht bei Schritt {step}: {label}',
      backToCurrent: 'Zurück zu {label}',
    },
    // ── Einreichunterlagen ──────────────────────────────────────────────
    // Die Zahlen in der Übersicht rechnet die Karte selbst aus den Zeilen —
    // es gibt kein Feld auf der Leitung, das ihnen widersprechen könnte.
    documentChecklist: {
      eyebrow: 'Unterlagen',
      itemAria: 'Unterlage: {label}',
      requirement: {
        required: 'erforderlich',
        conditional: 'bedingt',
      },
      // Der Zustand EINER Zeile. „nicht bekannt" ist der Normalfall: nur was
      // im Gespräch stand, darf hier stehen.
      status: {
        present: 'liegt vor',
        missing: 'fehlt',
        unknown: 'nicht bekannt',
      },
      // Dieselben Begriffe als Beiwort, damit „3 vorhanden" und „2 fehlend"
      // grammatikalisch stehen, wo „3 liegt vor" falsch wäre.
      tally: {
        required: 'erforderlich',
        conditional: 'bedingt',
        present: 'vorhanden',
        missing: 'fehlend',
        unknown: 'ungeklärt',
      },
      tallyAria: 'Stand der Unterlagen',
      // Steht statt der zweiten Zeile, wenn zu keiner Unterlage etwas bekannt
      // ist. Eine Leiste, die dann „0 von 5" zeigte, wäre eine Behauptung
      // über das Projekt und keine Zusammenfassung der Karte.
      noStatus: 'Ob Sie diese Unterlagen bereits haben, geht aus dem Gespräch nicht hervor.',
      condition: 'Bedingung',
      issuer: 'Ausgestellt von',
      form: 'Form',
      basis: 'Grundlage',
    },
    // ── Fristen ─────────────────────────────────────────────────────────
    deadlineTimeline: {
      eyebrow: 'Fristen',
      deadlineAria: 'Frist {index}: {label}',
      startsFrom: 'Fristbeginn',
      consequence: 'Wenn versäumt',
      actor: 'Zuständig',
      basis: 'Grundlage',
      // Der Satz, der die Karte ehrlich hält: Die Reihenfolge ist gezeichnet,
      // die Länge nicht — die Fristen laufen ab verschiedenen Ereignissen.
      notToScale: 'Die Reihenfolge ist maßstabslos dargestellt: Jede Frist läuft ab einem eigenen Ereignis.',
      noDatesNote: 'Die Fristen stehen so, wie sie die Bestimmung formuliert. Diese Karte rechnet kein Datum aus.',
    },
    // ── Auswirkung einer Änderung ───────────────────────────────────────
    changeImpact: {
      eyebrow: 'Auswirkung',
      consequenceAria: 'Auswirkung: {aspect}',
      changeWithBefore: '{factor}: {from} → {to}',
      changeWithoutBefore: '{factor} → {to}',
      // Steht unter der Kopfzeile, wenn der Ausgangswert fehlt. „Bisher" leer
      // zu lassen wäre die stillere, aber falschere Variante.
      currentUnknown: 'Der Ausgangswert geht aus dem Gespräch nicht hervor.',
      direction: {
        tightens: 'verschärft',
        relaxes: 'gelockert',
        unchanged: 'unverändert',
      },
      before: 'bisher',
      after: 'dann',
      unknownBefore: 'bisher nicht bekannt',
      basis: 'Grundlage',
    },
    verdictHeader: {
      confidenceHigh: 'hohe Sicherheit',
      confidenceMedium: 'mittlere Sicherheit',
      confidenceLow: 'geringe Sicherheit',
    },
    normChain: {
      eyebrow: 'Normenkette',
      // Rang des Rechtsakts. Die Namen sind die der österreichischen
      // Rechtsordnung und bleiben auch im Englischen stehen.
      rank: {
        bundesgesetz: 'Bundesgesetz',
        landesgesetz: 'Landesgesetz',
        verordnung: 'Verordnung',
        oibRichtlinie: 'OIB-Richtlinie',
        oenorm: 'ÖNORM',
        leitfaden: 'Leitfaden',
      },
      binding: 'bindend',
      // Eine OIB-Richtlinie bindet erst, wenn ein Land sie für verbindlich
      // erklärt — das steht am Glied, nicht in einer Fußnote.
      bindingWhenDeclared: 'bindend, wenn erklärt',
      interpretive: 'auslegend',
    },
    comparison: {
      eyebrow: 'Vergleich',
      criterion: 'Kriterium',
    },
    typedTable: {
      eyebrow: 'Tabelle',
    },
    // ── Beschriftungen in den Zeichnungen ──────────────────────────────────
    // Was in der Skizze selbst steht. Symbole (±0,00, Ø, N), Einheiten und
    // Normbezeichnungen (A++ … G, DnT,w) stehen bewusst nicht hier: sie sind
    // in jeder Sprache dasselbe Zeichen.
    schematics: {
      acoustic: {
        soundClass: 'Schallschutzklasse',
        airborne: 'Luftschall',
        impact: 'Trittschall',
        airborneResultant: 'Luftschall (resultierend)',
        lowerIsBetter: '↓ niedriger ist besser',
        higherIsBetter: '↑ höher ist besser',
        reserve: 'Reserve +{margin} dB',
        shortfall: 'Fehlbetrag {margin} dB',
      },
      daylight: {
        glassArea: 'Lichteintrittsfläche',
        window: 'Fenster',
        obstruction: 'Lichteinfall 45° — {label}',
        requiredArea:
          'Bodenfläche {floor} m² → erforderliche Lichteintrittsfläche ≥ {required} m² (10 %).',
        obstructionPierces: 'Die Verschattung durchdringt den 45°-Lichteinfallskegel.',
      },
      density: {
        coverage: 'Bebauungsgrad',
        parcel: 'Grundstück {area} m²',
        builtUp: 'bebaut',
        builtUpUnknown: 'bebaute Fläche: {missing}',
        grossFloorArea: 'Bruttogeschossfläche (BGF)',
      },
      egress: {
        totalWalkLength: 'Gehweglänge gesamt',
      },
      elevator: {
        accessible: 'Barrierefreier Aufzug',
        required: 'erforderlich',
        notRequired: 'nicht erforderlich',
        entranceLevel: 'Zugangsebene',
        shaft: 'Aufzug',
        // Geschossbezeichnung relativ zur Zugangsebene.
        groundFloor: 'EG',
        upperFloor: '{level}.OG',
        basement: '{level}.KG',
      },
      energy: {
        hwb: 'Heizwärmebedarf (HWB)',
        hwbMarker: 'HWB {value}',
        fgee: 'Gesamtenergieeffizienzfaktor (fGEE)',
      },
      fireAccess: {
        routeWidth: 'Zufahrt Breite',
        gateClearance: 'Durchfahrt lichte Höhe',
        aufstellflaecheWidth: 'Aufstellfläche Breite',
        aufstellflaecheLength: 'Aufstellfläche Länge',
        facadeDistance: 'Abstand zur Fassade',
        walkToEntrance: 'Weg zum Eingang',
        parcel: 'Grundstück {width} × {depth} m',
        route: 'ZUFAHRT',
        building: 'Gebäude',
        aufstellflaeche: 'Aufstellfläche',
        entrance: 'Eingang',
        street: 'STRASSE',
        gebaeudeklasse: 'Gebäudeklasse',
        walkTooFar: ' — der Weg zum Eingang überschreitet das zulässige Maß.',
      },
      fireCompartment: {
        storey: 'Geschoss {label}',
        plan: 'Grundriss',
      },
      guardrail: {
        context: {
          balkon: 'Balkon',
          loggia: 'Loggia',
          stiege: 'Stiege',
          fenster: 'Fenster',
          dachterrasse: 'Dachterrasse',
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
      parking: {
        car: 'Kfz-Stellplätze',
        bicycle: 'Fahrradabstellplätze',
        // Abkürzung für Stellplätze, die als Einheit hinter der Zahl steht.
        unit: 'Stpl.',
        basis: 'Bemessung',
        // Die Fehlmenge zählt: bei einem fehlenden Platz „1 fehlt“.
        short:
          '{provided} von {required} nachgewiesen — {missing, plural, one {# fehlt} other {# fehlen}}{overflow}',
        surplus: '{provided} nachgewiesen — Überschuss +{surplus}{overflow}',
        exact: '{provided} von {required} nachgewiesen{overflow}',
        truncated: ' (Ausschnitt)',
        legend: 'Gefüllt = nachgewiesen, gestrichelt = fehlend gegenüber der Anforderung.',
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
      },
      stair: {
        section: 'SCHNITT',
        plan: 'GRUNDRISS',
        // Stufennotation, wie sie im Schnitt eines Einreichplans steht.
        stepNotation: '{count} Stg · {rise}/{going} cm',
        // Ohne Steigung und Auftritt bleibt nur die Anzahl.
        stepCount: '{count, plural, one {# Stufe} other {# Stufen}}',
      },
      thermal: {
        roof: 'Dach',
        wall: 'Außenwand',
        window: 'Fenster',
        door: 'Tür',
        floor: 'Boden',
      },
    },
  },
  agentPrompt: {
    awaitingOther: 'Piloti wartet auf {name}',
    awaitingSomeone: 'Piloti wartet auf eine andere Person',
    needsInput: 'Piloti benötigt Ihre Eingabe',
    receivedInput: 'Piloti hat Ihre Eingabe erhalten',
    approve: 'Genehmigen',
    reject: 'Ablehnen',
    approvePlan: 'Plan genehmigen',
    rejectPlan: 'Plan ablehnen',
    selectOption: 'Option auswählen: {option}',
    yourResponse: 'Ihre Antwort:',
    approvalInstruction:
      'Wählen Sie „Genehmigen“, um die Recherche zu starten, oder „Ablehnen“, um abzubrechen.',
    durationHint:
      'Die Deep-Research-Ausführung kann mehrere Minuten dauern und verbraucht Kontingent.',
  },
  agentResponse: {
    viewProgress: 'Fortschritt anzeigen',
    viewReport: 'Bericht anzeigen',
    loading: 'Wird geladen …',
    loadingLabel: 'Wird geladen',
    errorTitle: 'Fehler: {message}',
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
    inProgress: 'Denkvorgang läuft',
    working: 'Antwort wird erstellt …',
    waiting: 'Warten auf Antwort',
    elapsedAria: 'Vergangen: {seconds, plural, one {# Sekunde} other {# Sekunden}}',
    // Live-Einzeiler, was der Assistent gerade tut — aus dem neuesten OFFENEN
    // Schritt, der sich für Lesende formulieren lässt. Bewusst ohne Eintrag
    // „zeig den Schrittnamen“: ein interner Bezeichner im Status-Gewand ist
    // Rauschen. Ein nicht klassifizierbarer Schritt fällt auf die vorige
    // sinnvolle Phrase zurück, sonst auf `working` weiter oben.
    activity: {
      understanding: 'Frage wird erfasst …',
      planning: 'Vorgehen wird geplant …',
      searchingWeb: 'Web wird durchsucht …',
      searchingKnowledge: 'OIB-Wissen wird durchsucht …',
      searchingRis: 'RIS (österreichisches Recht) wird durchsucht …',
      searchingSources: 'Quellen werden durchsucht …',
      researching: 'Recherche läuft …',
      reading: 'Ergebnisse werden gelesen …',
      composing: 'Antwort wird formuliert …',
    },
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
      // Korpus-NAMEN: „im OIB-Wissen“ ist Produkttext mit angeschweißter
      // Präposition, kein Eigenname. Das Backend schickt die ID.
      corpus: {
        knowledge: 'im OIB-Wissen',
        ris: 'im RIS',
        web: 'im Web',
        documents: 'in Ihren Unterlagen',
        ifc: 'im Gebäudemodell',
      },
      // Verbindet zwei Korpora in einer Zeile. Grammatik, also auch hier.
      corpusJoin: ' und ',
      status: {
        // Welche der eigenen Unterlagen gerade gesichtet werden. Ein
        // Schlüssel pro Ebene statt einer Vorlage mit Platzhalter: Deutsch
        // braucht den Dativ („aus dem Büroarchiv“), Englisch gar keinen
        // Artikel, also lässt sich der Name nicht in EINEN Satz einsetzen.
        // Jede Zeile nennt den Namen, den die Lesenden im Produkt sehen —
        // Büroarchiv, Projekt, Unterhaltung. Für mehrere Ebenen zugleich gibt
        // es keinen: der Sammelbegriff dafür ist unser Wort, nicht ihres, also
        // sagt `several` schlicht, WAS gelesen wird.
        documents: {
          archiv: 'Unterlagen aus dem Büroarchiv werden gesichtet …',
          project: 'Unterlagen aus dem Projekt werden gesichtet …',
          session: 'Unterlagen aus dieser Unterhaltung werden gesichtet …',
          several: 'Ihre Unterlagen werden gesichtet …',
        },
        // Die Routing-ENTSCHEIDUNG aus einer festen Auswahl. Die Begründung des
        // Klassifikators ist Freitext in der Sprache des Modells und steht
        // deshalb nie hier — sie wird zitiert, zugeschrieben, in der
        // nachgeordneten Zeile `routing.line` weiter unten.
        routing: {
          meta: 'Gespräch — keine Recherche nötig',
          outOfScope: 'Frage außerhalb des Fachgebiets',
          shallow: 'Kurzrecherche wird vorbereitet',
          deep: 'Tiefenrecherche wird vorbereitet',
        },
        // `{query}` sind die eigenen Worte der Lesenden, zurückgespiegelt —
        // nie übersetzt, und vom Backend gekürzt, damit die Zeile passt.
        retrieval: {
          withQuery: 'Sucht {corpus}: „{query}“',
          plain: 'Sucht {corpus} …',
        },
        // Werkzeuge, die keine Recherche sind, aber vom Nutzer gewollt waren.
        // Ein Werkzeug ohne Eintrag bekommt gar keine Zeile: sein interner
        // Name ist kein Status.
        action: {
          remember: 'Notiz wird gespeichert …',
          card: 'Ergebniskarte wird erstellt …',
        },
        citations: 'Belege werden geprüft …',
        escalation: 'Kurzrecherche reicht nicht — Tiefenrecherche startet',
      },
    },
    // Das eine Skill-Ereignis, das Lesende sehen, danach unterschieden, WER
    // entschieden hat. Zwei Sätze statt eines mit getauschtem Verb — dieser
    // Unterschied ist nicht in jeder Sprache ein Wort. `{skill}` ist der vom
    // Büro vergebene `grid-title` und reist unverändert: es ist ihr Name für
    // ihre eigene Arbeitsweise.
    skill: {
      activated: 'Skill „{skill}“ wird angewendet',
      forced: 'Skill „{skill}“ wurde angefordert',
    },
    // Kompakte Chips „was tatsächlich gelaufen ist" in der Herleitung-Basis —
    // ein Chip pro ausgeführtem Agenten/Tool, ohne Technik-Opt-in.
    executedSteps: 'Ausgeführt:',
    stepName: {
      understanding: 'Einordnung',
      routing: 'Rechercheweg',
      webSearch: 'Websuche',
      ris: 'RIS',
      corpus: 'OIB-Wissen',
      assistant: 'Assistent',
      reading: 'Lesen',
      // Ein Chip pro Skill, den dieser Turn tatsächlich angewendet hat.
      // `{name}` liefert die einzige Label-Instanz
      // (features/skills/lib/skill-activity).
      skill: 'Skill: {name}',
      // Das blanke `use_skill`-Frame ohne erkennbaren Skill dahinter.
      skillUnnamed: 'Skill',
    },
    // Lesbare Namen für die Knoten und Werkzeuge, die das Backend meldet — für
    // das Technik-Panel (Opt-in). Auf der Leitung stehen interne Ids
    // (`knowledge_search`), und NAT reicht zusätzlich LangChain-Span-Namen
    // durch, also CamelCase-Klassennamen. Deshalb löst das Panel jede Zeile
    // über diese Map auf, statt zu title-casen, was gerade ankam. Was schon
    // einen Chip hat, nutzt `stepName.*` oben mit: ein Knoten, eine Wortwahl.
    nodeName: {
      // Der Rahmen, der den ganzen Zug über offen ist — kein Schritt darin.
      workflow: 'Ablauf',
      clarification: 'Rückfrage',
      deepResearch: 'Tiefenrecherche',
      dataSources: 'Datenquellen',
      note: 'Notiz gespeichert',
      card: 'Ergebniskarte',
      documents: 'Dokumentenliste',
      askUser: 'Rückfrage an Sie',
      model: 'Gebäudemodell',
      measure: 'Modellmessung',
      compliance: 'Normprüfung',
      skillSelection: 'Skill-Auswahl',
      // Ein Knoten, für den dieser Build keinen Namen hat. Die Zeile bleibt —
      // das Panel zählt seine Schritte und jeder trägt eine Uhrzeit, ein
      // Weglassen ließe Liste und Zähler auseinanderlaufen und verschwiege,
      // dass etwas lief — sagt aber nur, dass intern etwas passiert ist. Der
      // rohe Name ist kein Vokabular, das man lernen kann (anders als ein
      // `status:`-Slot, der genau das ist und bewusst wörtlich bleibt); er ist,
      // wie das Framework diesen Span zufällig genannt hat.
      internal: 'Interner Schritt',
    },
    interrupted: 'Unterbrochen',
    // Kompakter Inline-Hinweis auf einer unterbrochenen Antwort: eine stille
    // Wiederverbindung kann eine laufende Antwort verwerfen (Protokoll-
    // Robustheit, Punkt 4). Statt nur des stummen „Unterbrochen“-Chips.
    interruptedNotice:
      'Verbindung kurz unterbrochen — Antwort ging verloren. Bitte erneut senden.',
    // Vorübergehender „Wird geprüft“-Zustand (FIX 3): angezeigt, solange der
    // Wiederherstellungs-Abruf nach einer Wiederverbindung läuft, damit ein
    // Zug, der nur unterbrochen AUSSIEHT, nicht sofort den „verloren“-Hinweis
    // zeigt, bevor bestätigt ist, dass die Antwort wirklich fehlt.
    recovering: 'Verbindung wird wiederhergestellt',
    recoveringNotice:
      'Verbindung wird wiederhergestellt — prüfe auf fertige Antwort …',
    done: 'Fertig',
    showThinking: 'Denkschritte anzeigen ({count})',
    showThinkingSteps: 'Denkschritte anzeigen ({count})',
    // Die Kopfzeile der Herleitung, aus zwei Klauseln gebaut. Die Quellen-
    // Klausel FEHLT, wenn es keine gibt: „0 Quellen“ ist eine wahre Zahl, die
    // sich wie ein Fehlschlag liest, und eine Antwort aus einer Messung am
    // Modell hat zu Recht keine Zitate. Gezählt wird, was da ist; über das,
    // was nicht da ist, sagt die Zeile nichts.
    herleitungSummary: 'Herleitung · {count, plural, one {# Schritt} other {# Schritte}}',
    herleitungSummaryWithSources:
      '{summary} · {count, plural, one {# Quelle} other {# Quellen}}',
    // Der Zug hat noch keinen Schritt gemeldet — dann nennt die Zeile nur, was
    // sie ist, statt „0 Schritte“ zu zählen.
    herleitungSummaryNoSteps: 'Herleitung',
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
    readNotUsed: 'gelesen, nicht verwendet',
    moreSources: '+{count} weitere',
    // Die an DIESE Nachricht angehängten Dateien. Die im Composer aktivierten
    // Datenquellen sind Verfügbarkeit, keine Aktivität, und stehen bewusst
    // nicht hier — was gelaufen ist, zeigt die `executedSteps`-Zeile darüber.
    attachedFiles: 'Angehängte Dateien:',
    // „Warum dieser Weg?“ — die Routing-Einordnung dieses Turns (WP-A
    // `routing_decision` + `routing_reason`), im Herleitungs-Rahmenknoten.
    routing: {
      whyLabel: 'Warum dieser Weg?',
      line: 'Einordnung: {decision} — {reason}',
      decision: {
        meta: 'Direktantwort',
        shallow: 'Kurzrecherche',
        deep: 'Tiefenrecherche',
        error: 'Fehler',
      },
    },
    // Einzeiler, wenn dieser Turn von der Kurz- zur Tiefenrecherche eskaliert ist.
    escalationNarration: 'Eskaliert zur Tiefenrecherche: {reason}',
    node: {
      framingTab: 'Einordnung',
      framingTitle: 'Frage verstanden',
      framingQuestion: 'Sie fragen: „{question}“',
      contextLabel: 'Kontext',
      sourcesTab: 'Quellen',
      sourcesTitle: 'Geprüfte Quellen',
      findingsTab: 'Einschätzung',
      // Reine Herleitungs-Info im Einschätzungsknoten: in welchen Quellenspuren
      // es Treffer gab. NICHT das Vertrauensurteil (Konfidenz/Belege) — das
      // steht einmal auf der Antwortkarte.
      findingsHits: 'Treffer in: {lanes}',
      // Die Beleg-Bilanz, dort genannt, wo der Fächer zusammenläuft: was
      // tatsächlich gelesen wurde, bevor die Quellenarten aufgezählt werden.
      findingsTally: '{hits} Treffer in {docs} Dokumenten',
      findingsTallyOne: '{hits} Treffer in 1 Dokument',
      // Während der Zug streamt gibt es noch keine Einschätzung, der Graph
      // braucht seinen Zusammenführungspunkt aber trotzdem — sonst hängen die
      // Quellenspalten in der Luft und die Form springt, sobald die Antwort da ist.
      findingsPendingTab: 'Einschätzung',
      findingsPending: 'Quellen werden abgewogen …',
      branchesTab: 'Folgewege',
      branchesSub: 'Wählen Sie eine Option — das Ergebnis wird für Ihre Wahl zusammengestellt.',
    },
  },
  deepResearch: {
    stats: {
      toolCalls: '{count, plural, one {# Werkzeugaufruf} other {# Werkzeugaufrufe}}',
    },
    success: {
      heading: 'Bericht abgeschlossen!{stats}',
      subheading:
        'Die Recherche ist abgeschlossen und ein Bericht steht im Recherchebereich zur Ansicht bereit.',
    },
    failure: {
      heading: 'Bericht konnte nicht abgeschlossen werden',
      subheading:
        'Etwas hat den Abschluss des Rechercheberichts verhindert. Prüfen Sie die Denkschritte für Details.',
    },
    cancelled: {
      heading: 'Recherche abgebrochen',
      subheading:
        'Die Recherche wurde vom Benutzer gestoppt. Sie können den Teilfortschritt im Recherchebereich ansehen.',
    },
    expired: {
      heading: 'Bericht abgelaufen',
      subheading: 'Der Bericht ist abgelaufen und nicht mehr verfügbar.',
    },
    starting: {
      heading: 'Deep Research wird gestartet',
      subheading:
        'Der Chat ist pausiert, während der Bericht erstellt wird, um zu verhindern, dass mehrere Berichte generiert werden. Sie können den Tab verlassen, während dies läuft – es kann mehrere Minuten dauern.',
    },
    viewReport: 'Bericht anzeigen',
    viewThinking: 'Denkschritte anzeigen',
    viewProgress: 'Fortschritt anzeigen',
    // Einzeiler über dem „Deep Research wird gestartet“-Banner, wenn der Turn
    // von der Kurz- zur Tiefenrecherche eskaliert ist (WP-A `escalation_reason`).
    escalationNarration: 'Eskaliert zur Tiefenrecherche: {reason}',
  },
  error: {
    showDetails: 'Details anzeigen',
    hideDetails: 'Details ausblenden',
    // Wiederholaktion bei einer fehlgeschlagenen Antwort (Designsprache:
    // „hilfreiche Meldung + erneut versuchen“).
    retry: 'Erneut versuchen',
  },
  errorRegistry: {
    connectionLost: {
      title: 'Verbindung getrennt',
      message: 'Die Verbindung zum Server wurde getrennt. Bitte überprüfen Sie Ihr Netzwerk.',
    },
    connectionFailed: {
      title: 'Verbindung fehlgeschlagen',
      message:
        'Verbindung zum Server nicht möglich. Bitte überprüfen Sie Ihre Netzwerkverbindung.',
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
    responseInterrupted: {
      title: 'Antwort unterbrochen',
      message: 'Ihre vorherige Anfrage wurde nicht abgeschlossen. Bitte senden Sie Ihre Nachricht erneut.',
    },
    workflowError: {
      title: 'Anfrage fehlgeschlagen',
      message:
        'Beim Bearbeiten Ihrer Anfrage ist beim Assistenten ein unerwarteter Fehler aufgetreten. Bitte versuchen Sie es erneut.',
    },
    deepResearchFailed: {
      title: 'Deep Research fehlgeschlagen',
      message: 'Beim Deep-Research-Vorgang ist ein Fehler aufgetreten.',
    },
    deepResearchLoadFailed: {
      title: 'Recherchedaten nicht verfügbar',
      message:
        'Recherchedaten konnten nicht geladen werden. Der Auftrag ist möglicherweise abgelaufen oder wurde gelöscht.',
    },
    unknown: {
      title: 'Etwas ist schiefgelaufen',
      message: 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.',
    },
    // Deep-Research-Auftrag wurde abgelehnt, weil die Warteschlange voll ist
    // (WP-A `job_admission_rejected`). Warnung, nicht Fehler: erneut senden hilft.
    researchQueueFull: {
      title: 'Recherche ausgelastet',
      message:
        'Die Recherche-Warteschlange ist gerade voll. Bitte senden Sie Ihre Anfrage in einem Moment erneut.',
      retryHint:
        'Bitte in etwa {seconds, plural, one {# Sekunde} other {# Sekunden}} erneut senden.',
    },
  },
  deepResearchErrors: {
    interrupted: 'Die Recherche wurde vor dem Abschluss unterbrochen.',
    reportUnavailable: 'Dieser Recherchebericht ist nicht mehr verfügbar.',
    serviceUnreachable:
      'Der Dienst ist derzeit nicht erreichbar. Bitte versuchen Sie es später erneut.',
    loadFailed: 'Recherchedaten konnten nicht geladen werden.',
  },
  sessionActions: {
    researchMayStillRunTitle: 'Recherche-Ausführung läuft möglicherweise noch',
    researchMayStillRunDescription:
      'Die Sitzung wurde gelöscht, aber der zugehörige Deep-Research-Auftrag konnte auf dem Server nicht gestoppt werden.',
    researchRunsMayStillRunTitle: 'Möglicherweise laufen noch {count} Recherche-{runLabel}',
    researchRunsMayStillRunDescription:
      'Die Sitzungen wurden gelöscht, aber einige Deep-Research-Aufträge konnten auf dem Server nicht gestoppt werden.',
    runSingular: 'Ausführung',
    runPlural: 'Ausführungen',
  },
  budgetExhausted: {
    title: 'Budget aufgebraucht',
    memberMessage:
      'Ihr Nutzungsbudget ist aufgebraucht, daher können derzeit keine neuen Nachrichten gesendet werden. Ihren eigenen Verbrauch finden Sie unter Organisation → Verbrauch & Budgets. Bitten Sie eine Organisations-Administratorin oder einen -Administrator, Ihr Limit zu erhöhen.',
    adminMessage:
      'Das Nutzungsbudget ist aufgebraucht, daher können derzeit keine neuen Nachrichten gesendet werden. Erhöhen Sie die Limits unter Organisation → Verbrauch & Budgets.',
  },
  fileUpload: {
    uploading:
      'Die Datei wird hochgeladen und verarbeitet. Bis zum Abschluss kann eine Datei nicht in Abfragen einbezogen werden.',
    pendingWarning:
      'Dateien stehen noch aus! Warten Sie, bis sie bereit sind, oder senden Sie Ihre Abfrage erneut, um OHNE diese Dateien fortzufahren.',
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
    // Zusatzsatz, der im Tooltip erklärt, WARUM die Einschätzung gedeckelt
    // wurde, je nach `answer_confidence_capped_reason` (WP-A, PB-9).
    cappedReasons: {
      ungrounded: 'Geringe Sicherheit: Antwort nicht durch Quellen belegt.',
      quoteUnverified:
        'Geringe Sicherheit: ein Zitat konnte nicht wörtlich in der Quelle bestätigt werden.',
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
  },
  // Antwort-Feedback per Daumen (WS-7, Feature-Flag `answer-feedback`).
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
    commentSubmit: 'Hinweis senden',
  },
  // Schaltfläche „Nachricht kopieren" auf den Nutzernachrichtenblasen
  copyMessage: {
    copy: 'Nachricht kopieren',
    copied: 'Kopiert',
    failed: 'Nachricht konnte nicht kopiert werden',
  },
}
