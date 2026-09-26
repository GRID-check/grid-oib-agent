export const languages = {
  de: 'Deutsch',
  en: 'English',
} as const

export type Locale = keyof typeof languages

export const defaultLang: Locale = 'de'
export const showDefaultLang = false

const de = {
  meta: {
    title: 'Piloti — Die KI-Plattform für Architektur- und Planungsbüros',
    description: 'Die KI-Plattform für Architektur- und Planungsbüros',
  },
  skipLink: 'Zum Inhalt springen',
  // Drawing-set index shown in the page margin (see SheetIndex.astro).
  sheets: {
    hero: '01 Start',
    story: '02 Problem und Lösung',
    nutzung: '03 Nutzung',
    daten: '04 Datengrundlage',
    ki: '05 Daten und Transparenz',
    wert: '06 Wert',
    team: '07 Team',
    kontakt: '08 Kontakt',
  },
  nav: {
    ariaLabel: 'Hauptnavigation',
    logoLabel: 'Piloti — Startseite',
    signIn: 'Anmelden',
    signInPending: 'Weiterleitung…',
    cta: 'Demo anfragen',
    langLabel: 'Sprache wählen',
  },
  hero: {
    title: 'Planen. Statt suchen.',
    sub: 'Das gesamte Wissen für Ihre Planung. An einem Ort.',
    ctaDemo: 'Demo anfragen',
    ctaMore: 'Mehr erfahren',
  },
  story: {
    problemA: 'Architekt:innen gestalten unsere Zukunft,',
    problemB: 'doch das Wissen dafür liegt verstreut.',
    solution:
      'Piloti verknüpft Projektdaten, Baurecht, Budget und Bürowissen zu einer soliden Wissensbasis.',
    cardTagline: 'Struktur, Verlässlichkeit und Überblick für jede Entwurfsentscheidung.',
    tags: {
      norm: '▸ NORM',
      site: '▸ STANDORT',
      material: '▸ MATERIAL',
      category: '▸ KATEGORIE',
      document: '▸ DOKUMENT',
      detail: '▸ DETAIL',
      plan: '▸ GRUNDRISS',
    },
    infoSubs: {
      fire: 'Brandschutz',
      energy: 'Energieeffizienz',
      connection: 'Anschlussdetail',
      construction: 'Konstruktionsdetail',
    },
  },
  nutzung: {
    tag: 'Nutzung',
    title: 'Zu jeder Planungsaufgabe das passende Wissen.',
    body: 'Sie entwerfen, Piloti liefert den Kontext: passende Projekterfahrung, einzuhaltende Rahmenbedingungen, die richtigen Materialkennwerte und Ihre Budgetziele — genau das, was Sie brauchen, um die richtigen Entscheidungen zu treffen.',
    big: 'Sekunden',
    sub: 'statt Stunden — Antwort mit Verweis auf Paragraf, Richtlinie und Herleitung.',
  },
  daten: {
    tag: 'Datengrundlage',
    title: 'Intelligente Planung auf solider Datenbasis.',
    body: 'Piloti stützt sich auf gepflegte, aktuelle Wissensquellen — von Landesbauordnungen und OIB-Richtlinien bis zu Materialdaten und CO₂-Werten. Jede Aussage lässt sich bis zu ihrem Ursprung zurückverfolgen.',
    cards: [
      { title: 'Regelwerke', body: 'Landesbauordnungen, OIB-Richtlinien' },
      { title: 'Ihr Büro', body: 'Pläne und Erfahrung aus vergangenen Projekten' },
      { title: 'Ihr Projekt', body: 'Standortresearch, Grundstück, Auflagen' },
      { title: 'Fachdaten', body: 'Materialkennwerte, CO₂-Bilanzen' },
    ],
  },
  ki: {
    tag: 'Daten & Transparenz',
    title:
      'Keine Blackbox. Piloti macht KI und Daten nachvollziehbar — die Verantwortung bleibt bei Ihnen.',
    // The section's claim is that everything here can be checked. So the right
    // column is a sheet you could check it against: what accompanies every
    // answer, and what happens to the office's data — with the page that has to
    // hold us to it linked at the foot.
    proof: {
      tag: 'Prüfblatt',
      answerHeading: 'Zu jeder Antwort',
      answer: [
        { label: 'Begründung', value: 'warum die Antwort so lautet' },
        { label: 'Annahmen', value: 'worauf sie beruht' },
        { label: 'Regeln', value: 'welche Vorschrift greift' },
        { label: 'Quellenverweis', value: 'Paragraf, Punkt, Seite' },
      ],
      dataHeading: 'Zu Ihren Daten',
      data: [
        { label: 'Verarbeitung', value: 'EU · nach DSGVO' },
        { label: 'KI-Training', value: 'nicht mit Ihren Daten' },
        { label: 'Pläne und Projekte', value: 'Eigentum Ihres Büros' },
      ],
      link: 'In der Datenschutzerklärung nachlesen',
    },
    cards: [
      {
        title: 'Spezialisiert auf Architektur',
        body: 'Piloti basiert auf einer branchenspezifisch entwickelten KI-Infrastruktur. Es kennt Landesbauordnungen und OIB-Richtlinien, versteht Bauteile, Konstruktionen und Typologien — und bezieht den konkreten Kontext Ihres Projekts mit ein.',
      },
      {
        title: 'Nachvollziehbar bis zur Quelle',
        body: 'Zu jeder Empfehlung sehen Sie Begründung, Annahmen und Regeln — und jeder Verweis führt zurück zum Ursprung: zum Paragrafen der Landesbauordnung, zum OIB-Punkt, zum Materialdatenblatt oder zu Ihrem eigenen Projekt.',
      },
      {
        title: 'Ihre Daten, Ihre Kontrolle',
        body: 'Pläne und Projekte gehören Ihrem Büro — wir trainieren keine KI-Modelle mit Ihren Daten. Cloud und KI laufen in der EU nach DSGVO, und Ihre Daten sind jederzeit exportierbar.',
      },
    ],
  },
  roi: {
    tag: 'Wert',
    title: 'Rechnen Sie selbst nach.',
    body: 'Wir nehmen an, dass rund 30\u00a0% einer Planungswoche in die Suche gehen — Normen, Vorprojekte, Kennwerte — und dass Piloti davon 40\u00a0% zurückgibt. Gemessen ist das noch nicht: Piloti ist ein Proof of Concept. Setzen Sie Ihr Büro und einen Beispielpreis ein und sehen Sie, was die Annahme wert wäre.',
    badge: 'Beispielrechnung',
    inputsLabel: 'Ihr Büro',
    fields: {
      seats: 'Planer:innen mit Piloti',
      salary: 'Medianes Jahresgehalt',
      price: 'Beispielpreis je Platz und Monat',
    },
    priceNote: 'Zum Durchspielen: Piloti hat noch keine Preisliste, das ist kein Angebot.',
    claimsLabel: 'Unsere Annahmen',
    claims: {
      week: 'Arbeitswoche',
      research: 'Anteil Recherche',
      saved: 'Davon gibt Piloti zurück',
    },
    claimsNote: 'Annahmen, keine Messwerte aus Kundenprojekten.',
    resultLabel: 'Jahreswert · Beispiel',
    resultNote: 'netto nach Beispielpreis, für Ihr ganzes Büro, wenn die Annahmen zutreffen',
    metrics: {
      hours: 'Zurückgewonnene Zeit',
      payback: 'Amortisiert nach',
      paybackNote: 'danach trägt sich jeder Platz selbst',
      ratio: 'Wert je Euro',
      ratioNote: 'Wert je 1 € zum Beispielpreis',
    },
    footnote:
      'Eine Beispielrechnung: unsere Annahmen, Ihre Zahlen, ein Beispielpreis. Kein Angebot und keine Zusage. Jeder Schritt steht offen —',
    footnoteLink: 'ganzer Rechenweg',
    cta: 'Zahlen gemeinsam durchgehen',
    subject: 'ROI-Rechnung',
    units: {
      hours: '{value} h/Jahr',
      hoursPlain: '{value} h',
      perHour: '{value}/h',
      times: '× {value}',
      perYear: '12 × {value}',
      minus: '−{value}',
      fte: '≈ {value} Vollzeitstellen',
      months: '{value} Monate',
      ratio: '{value}×',
      never: '—',
      office:
        'Diese Rechnung gilt für {seats} Plätze, ein medianes Jahresgehalt von {salary} und einen Beispielpreis von {price} je Platz und Monat.',
      officeOne:
        'Diese Rechnung gilt für einen Platz, ein medianes Jahresgehalt von {salary} und einen Beispielpreis von {price} je Platz und Monat.',
    },
  },
  rechenweg: {
    metaTitle: 'Rechenweg — Piloti',
    metaDescription:
      'Jeder Schritt hinter der Beispielrechnung von Piloti: unsere Annahmen, Ihre Zahlen, ein Beispielpreis, und was die Rechnung bewusst weglässt.',
    back: 'Zahlen ändern',
    tag: 'Rechenweg',
    title: 'Die ganze Rechnung, offen.',
    intro:
      'Eine Zahl mit Nachkommastelle ist noch kein Argument. Deshalb steht hier jeder Schritt, der zu ihr führt — samt der Stellen, an denen wir etwas annehmen, statt es zu wissen.',
    origins: {
      ours: 'Annahme',
      yours: 'Ihre Zahl',
      price: 'Beispiel',
      sum: 'Ergebnis',
    },
    originsLong: {
      ours: 'Unsere Annahme',
      yours: 'Ihre Zahl',
      price: 'Beispielpreis, kein Angebot',
      sum: 'Ergebnis',
    },
    week: {
      title: 'Die Woche einer Planer:in, wie wir sie annehmen',
      scale: '1 Feld = 1 Stunde',
      bracket: 'Recherche — 30\u00a0% der Woche',
      plan: 'Entwerfen, abstimmen, ausführen',
      rest: 'Recherche, die bleibt',
      back: 'Gibt Piloti zurück, angenommen',
    },
    ledger: {
      week: 'Arbeitswoche',
      research: 'Anteil Recherche, 30\u00a0%',
      back: 'Davon gibt Piloti zurück, 40\u00a0%',
      year: 'Über 44 Arbeitswochen',
      hourly: 'Ihr Stundensatz',
      hourlyNote: 'Bruttogehalt geteilt durch 1.760 Jahresstunden',
      perSeat: 'Wert je Platz und Jahr',
      licence: 'Beispielpreis, aufs Jahr',
      netPerSeat: 'Netto je Platz',
      seats: 'Plätze in Ihrem Büro',
      total: 'Jahreswert',
    },
    excludedTitle: 'Was in der Rechnung fehlt',
    excluded: [
      {
        text: 'Lohnnebenkosten. Wir rechnen mit dem Bruttogehalt, nicht mit den rund 30\u00a0% Dienstgeberanteil, die eine Stunde tatsächlich kostet.',
        effect: 'macht den Wert kleiner, als er ist',
      },
      {
        text: 'Einarbeitung und Umstellung. Kein Werkzeug wirkt am ersten Tag so wie im sechsten Monat.',
        effect: 'macht den Wert größer, als er anfangs ist',
      },
      {
        text: 'Vermiedene Planungsfehler, Nachträge, verlorene Ausschreibungen. Der teuerste Fehler ist der, den niemand rechtzeitig findet.',
        effect: 'gar nicht bewertet',
      },
    ],
    honesty:
      'Diese Zahlen sind Annahmen, keine Messwerte aus Kundenprojekten: Piloti ist ein Proof of Concept, und gemessen hat das noch niemand. Auch der Preis ist ein Beispiel, kein Angebot. Alles steht hier offen, damit Sie es durch Ihre eigenen Zahlen ersetzen können. Liegt Ihre Recherchezeit bei 20\u00a0%, halbiert sich der Wert je Platz fast.',
  },
  team: {
    tag: 'Team',
    title: 'Drei Gründer, ein Ziel: Wissen dort, wo geplant wird.',
    body: 'Piloti ist in der Gründung. Bis dahin arbeiten wir auf Basis einer Absichtserklärung (Letter of Intent) — und suchen Pilotbüros, die mitentwickeln.',
    listLabel: 'Die Gründer',
    // The caption under the section's riso plate (see craft/plates.ts).
    plateCaption: 'Tafel I — Drei Stützen',
    facts: [
      { label: 'Ort', value: 'Wien' },
      { label: 'Stand', value: 'Proof of Concept' },
      { label: 'Form', value: 'in Gründung' },
    ],
  },
  cta: {
    tag: 'Kontakt',
    title: 'Werden Sie Pilotbüro.',
    // The words of the title that get the pencil line; must occur in `title`.
    titleMark: 'Pilotbüro',
    // Decorative (aria-hidden): the section already says we are looking for
    // early pilot offices, so the stamp repeats it rather than saying it alone.
    stamp: 'Pilotphase',
    body: 'Wir entwickeln Piloti gemeinsam mit wenigen Büros, die früh dabei sein wollen.',
    getsLabel: 'Sie bekommen',
    gets: [
      'Frühen Zugang zu Piloti',
      'Einen direkten Draht zu uns Gründern',
      'Einfluss darauf, was als Nächstes gebaut wird',
    ],
    givesLabel: 'Sie geben',
    gives: ['Ehrliches Feedback', 'Echte Planungsfragen aus Ihrem Büroalltag'],
    primary: 'Pilotbüro werden',
    secondary: 'Gespräch vereinbaren',
    subjectPilot: 'Pilotbüro',
    subjectCall: 'Gespräch',
    direct: 'Oder schreiben Sie direkt an',
  },
  chat: {
    header: 'Piloti · Decision Chain',
    fictional: 'Fiktives Beispiel',
    question:
      'Ich will das Stiegenhaus ins Freie führen und über eine gedämmte Loggia-Fassade erschließen. Was heißt das brandschutztechnisch?',
    scanning: 'Quellen werden gesichtet …',
    oibTitle: 'Pkt. 3.5 — Fassaden',
    oibSub: 'Brandausbreitung über die Außenwand, GK 4',
    boTitle: '§ 106 — Fluchtwege',
    boSub: 'Stiegenhaus ins Freie, zweiter Rettungsweg',
    projTag: 'Projekt',
    projSub: 'WDVS 14 cm EPS, Loggia über 2 Geschoße',
    decision: 'Entscheidung',
    decisionIntro: 'Für Ihr WDVS (GK 4) haben Sie drei Wege:',
    optATitle: 'Loggia in A2',
    optASub: 'übrige Fassade EPS ≤ 10 cm',
    optBTitle: 'EPS > 10 cm mit Schott',
    optBSub: 'Brandschutzschott je Geschoß',
    optCTitle: 'Mit der Behörde klären',
    optCSub: 'Loggia als „offener Durchgang"',
    impl: 'Umsetzung — B',
    stepsBadge: '3 Schritte',
    steps: [
      'Schott je Geschoß im Fassadenschnitt eintragen',
      'Nachweis OIB-RL 2, Pkt. 3.5 der Einreichung beilegen',
      'Mehrkosten 4.200 € in die Kostenschätzung übernehmen',
    ],
    replay: '↻ Erneut abspielen',
  },
  chain: {
    typing: 'Frage wird eingegeben',
    beats: [
      'Frage aufgenommen',
      'Quellen werden gesichtet',
      'Quellen werden gezogen',
      'Baurecht wird geprüft',
      'Projektakt wird geprüft',
      'Alle Quellen geprüft',
      'Ergebnisse werden zusammengeführt',
      'Entscheidung — drei Wege',
      'Option B gewählt',
      'Umsetzung abgeleitet',
      'Vollständige Kette',
    ],
    aura: [
      'OIB-RL 2',
      null,
      'U-WERT',
      null,
      'BUDGET',
      null,
      null,
      'BO WIEN',
      null,
      null,
      ['PROJEKTARCHIV', 'VS Aspern 2019', 'Anschlussdetail'],
      ['PROJEKTARCHIV', 'Wohnbau Ottakring', 'Fassadenschnitt'],
    ] as (string | string[] | null)[],
  },
  footer: {
    ariaLabel: 'Footer',
    tagline: 'Die KI-Plattform für Architektur- und Planungsbüros. Entwickelt in Wien.',
    productHeading: 'Produkt',
    companyHeading: 'Mehr erfahren',
    legalHeading: 'Rechtliches',
    contactHeading: 'Kontakt',
    contactBody: 'Fragen, Einwände oder ein Pilotprojekt — schreiben Sie uns.',
    cta: 'Pilotbüro werden',
    usage: 'Nutzung',
    data: 'Datengrundlage',
    value: 'Wertrechner',
    working: 'Rechenweg',
    team: 'Team',
    blog: 'Blog',
    changelog: 'Neuerungen',
    privacy: 'Datenschutz',
    imprint: 'Impressum',
    rights: 'Alle Rechte vorbehalten.',
    // The title block: what a drawing states about itself in the corner of the
    // sheet. An empty value is filled with the current year.
    block: [
      { label: 'Projekt', value: 'Piloti' },
      { label: 'Ausgabe', value: '' },
      { label: 'Ort', value: 'Wien' },
      { label: 'Maßstab', value: '1:1' },
      { label: 'Stand', value: 'Proof of Concept' },
    ],
  },
  // The blog chrome. The two categories' names and descriptors live in
  // src/lib/categories.ts, next to their ids, because the content schema and
  // the CMS read them too.
  blog: {
    metaTitle: 'Blog — Piloti',
    metaDescription:
      'Das Journal für Büros und das Bautagebuch aus der Entwicklung: Planungspraxis, Baurecht und wie Piloti gebaut ist.',
    tag: 'Blog',
    heading: 'Aus dem Büro und von der Baustelle.',
    intro:
      'Zwei Stränge: Im Journal schreiben wir für Architektur- und Planungsbüros. Im Bautagebuch halten wir fest, wie Piloti entsteht, Eintrag für Eintrag.',
    filterLabel: 'Beiträge nach Kategorie',
    filterAll: 'Alle',
    categoryLabel: 'Kategorie',
    entry: 'Eintrag',
    logProject: 'Projekt',
    logEntries: 'Einträge',
    empty: 'Noch keine Beiträge — der erste Artikel ist in Arbeit.',
    readMore: 'Weiterlesen →',
    allPosts: '← Alle Beiträge',
  },
  // The changelog page. Its ENTRIES are not here: they come from
  // src/data/changelog.json, generated from releasenotes/notes/ on merge — see
  // docs/contributing/release-notes.md. Only the page chrome is translated here.
  changelog: {
    metaTitle: 'Neuerungen — Piloti',
    metaDescription:
      'Was sich in Piloti geändert hat: neue Funktionen, Verbesserungen und Fehlerbehebungen, laufend aktualisiert.',
    tag: 'Neuerungen',
    heading: 'Was sich in Piloti getan hat.',
    intro:
      'Jede Änderung, die Sie in der Anwendung bemerken — neue Funktionen, Verbesserungen, behobene Fehler. Neueste zuerst.',
    empty: 'Noch keine Einträge — die erste Änderung erscheint hier, sobald sie ausgeliefert ist.',
    unreleased: 'In Kürze',
    versionLabel: 'Version',
  },
  notFound: {
    metaTitle: 'Seite nicht gefunden — Piloti',
    metaDescription: 'Diese Seite existiert nicht.',
    heading: 'Diese Seite liegt nicht im Plan.',
    body: 'Die gesuchte Seite existiert nicht oder wurde verschoben.',
    home: 'Zur Startseite',
    plateCaption: 'Tafel IV — Bauplatz',
  },
  legal: {
    tag: 'Rechtliches',
    emailLabel: 'E-Mail',
    updated: 'Stand: September 2026',
    impressum: {
      metaTitle: 'Impressum — Piloti',
      metaDescription: 'Impressum und Offenlegung der Piloti-Website.',
      heading: 'Impressum',
      ownerHeading: 'Medieninhaber, Herausgeber und Diensteanbieter',
      legalForm: 'Gesellschaft bürgerlichen Rechts (GesbR)',
      brand: 'auftretend unter der Projektbezeichnung „Piloti"',
      statusHeading: 'Status',
      status:
        'Piloti befindet sich in Gründung. Eine im Firmenbuch eingetragene Gesellschaft besteht noch nicht; die Gründer arbeiten auf Grundlage einer Absichtserklärung (Letter of Intent) zusammen. Es gibt daher weder eine Firmenbuchnummer noch eine UID-Nummer.',
      purposeHeading: 'Unternehmensgegenstand',
      purpose: 'Entwicklung einer KI-gestützten Wissensplattform für Architektur- und Planungsbüros.',
      directionHeading: 'Grundlegende Richtung',
      direction:
        'Information über Piloti sowie Beiträge zu Planungspraxis, Baurecht und zur Entwicklung der Plattform.',
      liabilityHeading: 'Haftung für Inhalte und Links',
      liability:
        'Die Inhalte dieser Website werden mit Sorgfalt erstellt. Für Richtigkeit, Vollständigkeit und Aktualität wird keine Gewähr übernommen. Inhalte zu baurechtlichen Themen stellen keine Rechtsberatung dar. Für die Inhalte verlinkter externer Seiten sind ausschließlich deren Betreiber verantwortlich.',
    },
    datenschutz: {
      metaTitle: 'Datenschutz — Piloti',
      metaDescription: 'Datenschutzerklärung der Piloti-Website.',
      heading: 'Datenschutzerklärung',
      controllerHeading: 'Verantwortlicher',
      sections: [
        {
          heading: 'Diese Website',
          html: 'Die öffentlichen Seiten dieser Website setzen <strong>keine Cookies</strong> und verwenden <strong>keine Tracking- oder Analysewerkzeuge</strong>. Schriften und Skripte werden von unserem eigenen Server geladen; es werden keine Inhalte von Drittanbietern eingebunden.',
        },
        {
          heading: 'Hosting und Server-Logs',
          html: 'Die Website wird bei der XPAX GmbH (IPAX), Österreich, betrieben. Beim Aufruf werden technisch notwendige Verbindungsdaten (IP-Adresse, Zeitpunkt, abgerufene Seite) verarbeitet, um Betrieb und Sicherheit der Website zu gewährleisten. Zum Schutz vor Missbrauch zählen wir Anfragen je IP-Adresse kurzzeitig mit (Rate Limiting). Rechtsgrundlage ist unser berechtigtes Interesse (Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;f DSGVO). Diese Daten werden nicht mit anderen Datenquellen zusammengeführt.',
        },
        {
          heading: 'Weiterleitung von www.piloti.at',
          html: 'Aufrufe von <em>www.piloti.at</em> werden über Cloudflare, Inc. (USA) auf <em>piloti.at</em> weitergeleitet. Dabei verarbeitet Cloudflare Ihre IP-Adresse. Cloudflare ist unter dem EU-US Data Privacy Framework zertifiziert (Art.&nbsp;45 DSGVO). Rufen Sie <em>piloti.at</em> direkt auf, ist Cloudflare nicht beteiligt.',
        },
        {
          heading: 'Kontaktaufnahme per E-Mail',
          html: 'Schreiben Sie uns, verarbeiten wir die übermittelten Daten (Name, E-Mail-Adresse, Inhalt der Anfrage), um Ihre Anfrage zu beantworten (Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO bzw. lit.&nbsp;f bei allgemeinen Anfragen). Ihre Nachricht landet in den Postfächern der Gründer und wird bei deren E-Mail-Anbietern gespeichert. Wir löschen sie, sobald sie für die Bearbeitung nicht mehr erforderlich ist und keine gesetzliche Aufbewahrungspflicht besteht.',
        },
        {
          heading: 'Anmeldung und Piloti-Anwendung',
          html: 'Mit „Anmelden" verlassen Sie diese Website und gelangen zur Piloti-Anwendung; dort gilt deren eigene Datenschutzerklärung. Kurz vorab: Die Anmeldung läuft über WorkOS, Inc. (USA). KI-Anfragen werden über OpenRouter, Inc. (USA) an Modellanbieter weitergeleitet, die ihren Sitz auch außerhalb der EU haben können. Wir selbst trainieren keine KI-Modelle mit Ihren Daten.',
        },
        {
          heading: 'Redaktionsbereich',
          html: 'Unter <em>/keystatic</em> liegt der Redaktionsbereich, in dem wir Blogbeiträge verfassen. Er ist nicht für Besucher gedacht. Wer ihn öffnet, lädt Dienste von Keystatic Cloud (Thinkmill), GitHub und Google Fonts; zur Anmeldung werden dort Cookies und lokaler Speicher verwendet.',
        },
        {
          heading: 'Ihre Rechte',
          html: 'Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch. Schreiben Sie uns dazu einfach eine E-Mail. Außerdem können Sie sich bei der Österreichischen Datenschutzbehörde beschweren (Barichgasse 40–42, 1030 Wien, <a href="https://www.dsb.gv.at" rel="noopener">dsb.gv.at</a>).',
        },
      ],
    },
  },
}

const en: typeof de = {
  meta: {
    title: 'Piloti — The AI platform for architecture and planning firms',
    description: 'The AI platform for architecture and planning firms',
  },
  skipLink: 'Skip to content',
  // Drawing-set index shown in the page margin (see SheetIndex.astro).
  sheets: {
    hero: '01 Start',
    story: '02 Problem and solution',
    nutzung: '03 Usage',
    daten: '04 Data foundation',
    ki: '05 Data and transparency',
    wert: '06 Value',
    team: '07 Team',
    kontakt: '08 Contact',
  },
  nav: {
    ariaLabel: 'Main navigation',
    logoLabel: 'Piloti — homepage',
    signIn: 'Sign in',
    signInPending: 'Redirecting…',
    cta: 'Request a demo',
    langLabel: 'Choose language',
  },
  hero: {
    title: 'Plan. Instead of searching.',
    sub: 'All the knowledge for your planning. In one place.',
    ctaDemo: 'Request a demo',
    ctaMore: 'Learn more',
  },
  story: {
    problemA: 'Architects shape our future,',
    problemB: 'yet the knowledge it takes is scattered.',
    solution:
      'Piloti connects project data, building law, budget and office knowledge into one solid knowledge base.',
    cardTagline: 'Structure, reliability and clarity for every design decision.',
    tags: {
      norm: '▸ NORM',
      site: '▸ SITE',
      material: '▸ MATERIAL',
      category: '▸ CATEGORY',
      document: '▸ DOCUMENT',
      detail: '▸ DETAIL',
      plan: '▸ FLOOR PLAN',
    },
    infoSubs: {
      fire: 'Fire safety',
      energy: 'Energy efficiency',
      connection: 'Connection detail',
      construction: 'Construction detail',
    },
  },
  nutzung: {
    tag: 'Usage',
    title: 'The right knowledge for every planning task.',
    body: 'You design, Piloti delivers the context: relevant project experience, the constraints to meet, the right material values and your budget targets — exactly what you need to make the right decisions.',
    big: 'Seconds',
    sub: 'instead of hours — an answer with references to the clause, the guideline and its derivation.',
  },
  daten: {
    tag: 'Data foundation',
    title: 'Intelligent planning on a solid data foundation.',
    body: 'Piloti draws on maintained, up-to-date knowledge sources — from state building codes and OIB guidelines to material data and CO₂ values. Every statement can be traced back to its origin.',
    cards: [
      { title: 'Regulations', body: 'State building codes, OIB guidelines' },
      { title: 'Your office', body: 'Plans and experience from past projects' },
      { title: 'Your project', body: 'Site research, plot, official requirements' },
      { title: 'Technical data', body: 'Material values, CO₂ balances' },
    ],
  },
  ki: {
    tag: 'Data & transparency',
    title: 'No black box. Piloti makes AI and data traceable — responsibility stays with you.',
    proof: {
      tag: 'Check sheet',
      answerHeading: 'With every answer',
      answer: [
        { label: 'Reasoning', value: 'why the answer is what it is' },
        { label: 'Assumptions', value: 'what it rests on' },
        { label: 'Rules', value: 'which regulation applies' },
        { label: 'Source reference', value: 'clause, section, page' },
      ],
      dataHeading: 'With your data',
      data: [
        { label: 'Processing', value: 'EU · under the GDPR' },
        { label: 'AI training', value: 'never on your data' },
        { label: 'Plans and projects', value: 'owned by your office' },
      ],
      link: 'Read it in the privacy policy',
    },
    cards: [
      {
        title: 'Specialised in architecture',
        body: 'Piloti is built on industry-specific AI infrastructure. It knows state building codes and OIB guidelines, understands components, constructions and typologies — and factors in the concrete context of your project.',
      },
      {
        title: 'Traceable to the source',
        body: 'Every recommendation shows its reasoning, assumptions and rules — and every reference leads back to the origin: the clause of the state building code, the OIB section, the material data sheet or your own project.',
      },
      {
        title: 'Your data, your control',
        body: 'Plans and projects belong to your office — we do not train AI models on your data. Cloud and AI run in the EU under the GDPR, and your data is exportable at any time.',
      },
    ],
  },
  roi: {
    tag: 'Value',
    title: 'Do the maths yourself.',
    body: 'We assume that around 30% of a planning week goes into the search — codes, past projects, reference values — and that Piloti gives 40% of that back. Nobody has measured this yet: Piloti is a proof of concept. Put in your office and an example price and see what the assumption would be worth.',
    badge: 'Example calculation',
    inputsLabel: 'Your office',
    fields: {
      seats: 'Planners using Piloti',
      salary: 'Median annual salary',
      price: 'Example price per seat per month',
    },
    priceNote: 'For trying things out: Piloti has no price list yet, and this is not an offer.',
    claimsLabel: 'Our assumptions',
    claims: {
      week: 'Work week',
      research: 'Share spent searching',
      saved: 'Of that, Piloti gives back',
    },
    claimsNote: 'Assumptions, not measurements from customer projects.',
    resultLabel: 'Annual value · example',
    resultNote: 'net of the example price, across your whole office, if the assumptions hold',
    metrics: {
      hours: 'Time recovered',
      payback: 'Pays for itself in',
      paybackNote: 'after that every seat carries itself',
      ratio: 'Value per euro',
      ratioNote: 'value per €1 at the example price',
    },
    footnote:
      'An example calculation: our assumptions, your numbers, an example price. Not an offer and not a promise. Every step is in the open —',
    footnoteLink: 'the whole calculation',
    cta: 'Walk through the numbers with us',
    subject: 'ROI calculation',
    units: {
      hours: '{value} h/year',
      hoursPlain: '{value} h',
      perHour: '{value}/h',
      times: '× {value}',
      perYear: '12 × {value}',
      minus: '−{value}',
      fte: '≈ {value} full-time roles',
      months: '{value} months',
      ratio: '{value}×',
      never: '—',
      office:
        'This working is for {seats} seats, a median salary of {salary} and an example price of {price} per seat per month.',
      officeOne:
        'This working is for one seat, a median salary of {salary} and an example price of {price} per seat per month.',
    },
  },
  rechenweg: {
    metaTitle: 'The maths — Piloti',
    metaDescription:
      'Every step behind the Piloti example calculation: our assumptions, your numbers, an example price, and what the calculation leaves out.',
    back: 'Change the numbers',
    tag: 'The maths',
    title: 'The whole calculation, in the open.',
    intro:
      'A figure with a decimal point is not yet an argument. So every step behind it is written out here — including the places where we assume something rather than know it.',
    origins: {
      ours: 'Assumed',
      yours: 'Yours',
      price: 'Example',
      sum: 'Result',
    },
    originsLong: {
      ours: 'Our assumption',
      yours: 'Your number',
      price: 'Example price, not an offer',
      sum: 'Result',
    },
    week: {
      title: 'One planner’s week, as we assume it',
      scale: '1 cell = 1 hour',
      bracket: 'Searching — 30% of the week',
      plan: 'Designing, coordinating, delivering',
      rest: 'Searching that remains',
      back: 'Piloti gives back, assumed',
    },
    ledger: {
      week: 'Work week',
      research: 'Share spent searching, 30%',
      back: 'Of that, Piloti gives back, 40%',
      year: 'Over 44 working weeks',
      hourly: 'Your hourly cost',
      hourlyNote: 'gross salary divided by 1,760 hours a year',
      perSeat: 'Value per seat per year',
      licence: 'Example price, per year',
      netPerSeat: 'Net per seat',
      seats: 'Seats in your office',
      total: 'Annual value',
    },
    excludedTitle: 'What the calculation leaves out',
    excluded: [
      {
        text: 'Employer on-costs. We use gross salary, not the roughly 30% on top that an hour actually costs the office.',
        effect: 'makes the value smaller than it is',
      },
      {
        text: 'Onboarding and the switch itself. No tool works on day one the way it works in month six.',
        effect: 'makes the value larger than it is at first',
      },
      {
        text: 'Planning errors avoided, variation orders, tenders lost. The most expensive mistake is the one nobody catches in time.',
        effect: 'not valued at all',
      },
    ],
    honesty:
      'These are assumptions, not measurements from customer projects: Piloti is a proof of concept, and nobody has measured this yet. The price is an example too, not an offer. It is all in the open so you can replace it with your own numbers. If your search time is 20%, the value per seat nearly halves.',
  },
  team: {
    tag: 'Team',
    title: 'Three founders, one aim: knowledge where the planning happens.',
    body: 'Piloti is still being founded. Until then we work under a letter of intent — and we are looking for pilot offices to build it with us.',
    listLabel: 'The founders',
    plateCaption: 'Plate I — Three columns',
    facts: [
      { label: 'Place', value: 'Vienna' },
      { label: 'Stage', value: 'Proof of concept' },
      { label: 'Form', value: 'Being founded' },
    ],
  },
  cta: {
    tag: 'Contact',
    title: 'Become a pilot office.',
    titleMark: 'pilot office',
    stamp: 'Pilot phase',
    body: 'We are building Piloti together with a small number of offices that want to be in early.',
    getsLabel: 'You get',
    gets: [
      'Early access to Piloti',
      'A direct line to us, the founders',
      'A say in what gets built next',
    ],
    givesLabel: 'You give',
    gives: ['Honest feedback', 'Real planning questions from your office'],
    primary: 'Become a pilot office',
    secondary: 'Book a call',
    subjectPilot: 'Pilot office',
    subjectCall: 'Call',
    direct: 'Or write directly to',
  },
  chat: {
    header: 'Piloti · Decision Chain',
    fictional: 'Fictional example',
    question:
      'I want to lead the stairwell to the outside and provide access via an insulated loggia façade. What does that mean in terms of fire protection?',
    scanning: 'Reviewing sources …',
    oibTitle: 'Sec. 3.5 — Façades',
    oibSub: 'Fire spread across the exterior wall, GK 4',
    boTitle: '§ 106 — Escape routes',
    boSub: 'Stairwell to the outside, second escape route',
    projTag: 'Project',
    projSub: 'ETICS 14 cm EPS, loggia across 2 storeys',
    decision: 'Decision',
    decisionIntro: 'For your ETICS (GK 4) you have three options:',
    optATitle: 'Loggia in A2',
    optASub: 'remaining façade EPS ≤ 10 cm',
    optBTitle: 'EPS > 10 cm with fire stop',
    optBSub: 'fire stop on each storey',
    optCTitle: 'Clarify with the authority',
    optCSub: 'loggia as an "open passage"',
    impl: 'Implementation — B',
    stepsBadge: '3 steps',
    steps: [
      'Add the fire stop on each storey in the façade section',
      'Attach the OIB-RL 2, Sec. 3.5 verification to the submission',
      'Carry the additional €4,200 into the cost estimate',
    ],
    replay: '↻ Replay',
  },
  chain: {
    typing: 'Entering question',
    beats: [
      'Question received',
      'Reviewing sources',
      'Fetching sources',
      'Checking building law',
      'Checking project file',
      'All sources checked',
      'Merging results',
      'Decision — three options',
      'Option B selected',
      'Implementation derived',
      'Complete chain',
    ],
    aura: [
      'OIB-RL 2',
      null,
      'U-WERT',
      null,
      'BUDGET',
      null,
      null,
      'BO WIEN',
      null,
      null,
      ['PROJECT ARCHIVE', 'VS Aspern 2019', 'Connection detail'],
      ['PROJECT ARCHIVE', 'Wohnbau Ottakring', 'Façade section'],
    ] as (string | string[] | null)[],
  },
  footer: {
    ariaLabel: 'Footer',
    tagline: 'The AI platform for architecture and planning firms. Built in Vienna.',
    productHeading: 'Product',
    companyHeading: 'Learn more',
    legalHeading: 'Legal',
    contactHeading: 'Contact',
    contactBody: 'Questions, objections or a pilot project — write to us.',
    cta: 'Become a pilot office',
    usage: 'Usage',
    data: 'Data foundation',
    value: 'Value calculator',
    working: 'The maths',
    team: 'Team',
    blog: 'Blog',
    changelog: "What's new",
    privacy: 'Privacy',
    imprint: 'Imprint',
    rights: 'All rights reserved.',
    block: [
      { label: 'Project', value: 'Piloti' },
      { label: 'Issue', value: '' },
      { label: 'Place', value: 'Vienna' },
      { label: 'Scale', value: '1:1' },
      { label: 'Stage', value: 'Proof of concept' },
    ],
  },
  blog: {
    metaTitle: 'Blog — Piloti',
    metaDescription:
      'The Journal for offices and the build log from development: planning practice, building law and how Piloti is built.',
    tag: 'Blog',
    heading: 'From the office and from the site.',
    intro:
      'Two strands: in the Journal we write for architecture and planning offices. In the build log we record how Piloti comes together, entry by entry.',
    filterLabel: 'Posts by category',
    filterAll: 'All',
    categoryLabel: 'Category',
    entry: 'Entry',
    logProject: 'Project',
    logEntries: 'Entries',
    empty: 'No posts yet — the first article is in the works.',
    readMore: 'Read on →',
    allPosts: '← All posts',
  },
  changelog: {
    metaTitle: "What's new — Piloti",
    metaDescription:
      'What changed in Piloti: new features, improvements and fixes, updated continuously.',
    tag: "What's new",
    heading: 'What has changed in Piloti.',
    intro:
      'Every change you can notice in the product — new features, improvements, fixes. Newest first.',
    empty: 'Nothing here yet — the first change appears the day it ships.',
    unreleased: 'Coming up',
    versionLabel: 'Version',
  },
  notFound: {
    metaTitle: 'Page not found — Piloti',
    metaDescription: 'This page does not exist.',
    heading: 'This page is not in the plan.',
    body: 'The page you are looking for does not exist or has been moved.',
    home: 'Back to the homepage',
    plateCaption: 'Plate IV — Building site',
  },
  legal: {
    tag: 'Legal',
    emailLabel: 'Email',
    updated: 'Last updated: September 2026',
    impressum: {
      metaTitle: 'Imprint — Piloti',
      metaDescription: 'Imprint and disclosure of the Piloti website.',
      heading: 'Imprint',
      ownerHeading: 'Media owner, publisher and service provider',
      legalForm: 'civil-law partnership (GesbR) under Austrian law',
      brand: 'operating under the project name "Piloti"',
      statusHeading: 'Status',
      status:
        'Piloti is being founded. No company is registered in the commercial register yet; the founders work together on the basis of a letter of intent. There is therefore no company register number and no VAT ID.',
      purposeHeading: 'Business purpose',
      purpose: 'Development of an AI-supported knowledge platform for architecture and planning firms.',
      directionHeading: 'Editorial direction',
      direction:
        'Information about Piloti, and articles on planning practice, building law and the development of the platform.',
      liabilityHeading: 'Liability for content and links',
      liability:
        'The content of this website is created with care. No guarantee is given for accuracy, completeness or currency. Content on building-law topics does not constitute legal advice. The operators of linked external sites are solely responsible for their content.',
    },
    datenschutz: {
      metaTitle: 'Privacy — Piloti',
      metaDescription: 'Privacy policy of the Piloti website.',
      heading: 'Privacy policy',
      controllerHeading: 'Controller',
      sections: [
        {
          heading: 'This website',
          html: 'The public pages of this website set <strong>no cookies</strong> and use <strong>no tracking or analytics tools</strong>. Fonts and scripts are served from our own server; no third-party content is embedded.',
        },
        {
          heading: 'Hosting and server logs',
          html: 'The website is hosted by XPAX GmbH (IPAX), Austria. When you visit it, technically necessary connection data (IP address, time, page requested) is processed to keep the website running and secure. To protect against abuse we briefly count requests per IP address (rate limiting). The legal basis is our legitimate interest (Art. 6(1)(f) GDPR). This data is not merged with other data sources.',
        },
        {
          heading: 'Redirect from www.piloti.at',
          html: 'Requests to <em>www.piloti.at</em> are redirected to <em>piloti.at</em> by Cloudflare, Inc. (USA), which processes your IP address in doing so. Cloudflare is certified under the EU-US Data Privacy Framework (Art. 45 GDPR). If you open <em>piloti.at</em> directly, Cloudflare is not involved.',
        },
        {
          heading: 'Contacting us by email',
          html: 'If you write to us, we process the data you send (name, email address, content of your enquiry) to answer it (Art. 6(1)(b) GDPR, or (f) for general enquiries). Your message arrives in the founders\' mailboxes and is stored by their email providers. We delete it once it is no longer needed and no statutory retention period applies.',
        },
        {
          heading: 'Sign-in and the Piloti application',
          html: '"Sign in" takes you from this website to the Piloti application, which has its own privacy policy. In short: sign-in is handled by WorkOS, Inc. (USA). AI requests are routed through OpenRouter, Inc. (USA) to model providers that may be based outside the EU. We do not train AI models on your data.',
        },
        {
          heading: 'Editorial area',
          html: '<em>/keystatic</em> is the editorial area where we write blog posts. It is not meant for visitors. Opening it loads services from Keystatic Cloud (Thinkmill), GitHub and Google Fonts, and uses cookies and local storage for sign-in.',
        },
        {
          heading: 'Your rights',
          html: 'You have the right of access, rectification, erasure, restriction of processing, data portability and objection; just email us. You may also lodge a complaint with the Austrian Data Protection Authority (Barichgasse 40–42, 1030 Vienna, <a href="https://www.dsb.gv.at" rel="noopener">dsb.gv.at</a>).',
        },
      ],
    },
  },
}

export const ui = { de, en }

export const landingScript = {
  de: {
    question: de.chat.question,
    typing: de.chain.typing,
    beats: de.chain.beats,
    aura: de.chain.aura,
    roi: de.roi.units,
  },
  en: {
    question: en.chat.question,
    typing: en.chain.typing,
    beats: en.chain.beats,
    aura: en.chain.aura,
    roi: en.roi.units,
  },
}
