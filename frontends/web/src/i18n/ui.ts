export const languages = {
  de: 'Deutsch',
  en: 'English',
} as const

export type Locale = keyof typeof languages

export const defaultLang: Locale = 'de'
export const showDefaultLang = false

const de = {
  // The landing page's head, and the fallback for any page that sets none.
  // `description` is also the one sentence that says what Piloti is, wherever
  // a machine reads it: og:description, the JSON-LD graph and /llms.txt.
  meta: {
    title: 'KI für Architektur- und Planungsbüros in Österreich — Piloti',
    description:
      'Piloti ist die KI-Wissensplattform für Architektur- und Planungsbüros in Österreich: Antworten zu Baurecht, OIB-Richtlinien und Projektunterlagen, mit Quellen.',
  },
  // Every other page's <title> and meta description, and what the head needs
  // around them. Titles stay near 60 characters, descriptions near 155.
  seo: {
    pages: {
      blog: {
        title: 'Blog: Baurecht, Planungspraxis und KI im Büro — Piloti',
        description:
          'Das Journal für Architektur- und Planungsbüros und das Bautagebuch aus der Entwicklung: Baurecht in Österreich, OIB-Richtlinien und wie Piloti gebaut ist.',
      },
      journal: {
        title: 'Journal: Baurecht und Planungspraxis für Büros — Piloti Blog',
        description:
          'Für Architektur- und Planungsbüros: Baurecht in Österreich verständlich, OIB-Richtlinien und Landesbauordnungen eingeordnet, und was KI im Büroalltag ändert.',
      },
      bautagebuch: {
        title: 'Bautagebuch: Notizen aus der Entwicklung — Piloti Blog',
        description:
          'Wie Piloti gebaut ist und warum: Notizen aus der Entwicklung einer KI-Wissensplattform für Baurecht, Projektunterlagen und Bürowissen, geschrieben in Wien.',
      },
      changelog: {
        title: 'Neuerungen: neue Funktionen und Verbesserungen — Piloti',
        description:
          'Was sich in Piloti geändert hat: neue Funktionen, Verbesserungen und Fehlerbehebungen der KI-Wissensplattform für Architekturbüros, laufend aktualisiert.',
      },
      rechenweg: {
        title: 'Rechenweg: So rechnet der Piloti-Wertrechner — Piloti',
        description:
          'Jeder Schritt hinter der Beispielrechnung von Piloti: unsere Annahmen, Ihre Zahlen, ein Beispielpreis, und was die Rechnung bewusst weglässt.',
      },
      impressum: {
        title: 'Impressum — Piloti',
        description:
          'Impressum und Offenlegung der Piloti-Website nach § 5 ECG und § 25 MedienG: wer hinter Piloti steht, wo wir sitzen und wie Sie uns erreichen.',
      },
      datenschutz: {
        title: 'Datenschutzerklärung — Piloti',
        description:
          'Wie die Piloti-Website mit Ihren Daten umgeht: keine Cookies, kein Tracking, welche Dienste beteiligt sind und welche Anbieter die Piloti-Anwendung nutzt.',
      },
      notFound: {
        title: 'Seite nicht gefunden — Piloti',
        description: 'Diese Seite existiert nicht oder wurde verschoben.',
      },
    },
    postTitleSuffix: ' — Piloti',
    ogImageAlt: 'Piloti: Planen. Statt suchen. KI für Architektur- und Planungsbüros.',
    breadcrumbHome: 'Start',
    byline: 'Von',
    and: 'und',
    rssTitle: 'Piloti Blog',
    rssDescription:
      'Journal und Bautagebuch von Piloti: Baurecht, Planungspraxis und die Entwicklung einer KI-Wissensplattform für Architekturbüros.',
    llmsPages: 'Seiten (Deutsch)',
    llmsPosts: 'Blog (Deutsch)',
    llmsFacts: 'Entwickelt in Wien von {founders}. Kontakt: {email}.',
  },
  // Answers an office, or an answer engine asked on its behalf, looks for.
  // Facts only: `{founders}` and `{email}` are filled from founders.ts and
  // consts.ts by `faqItems()` in lib/seo.ts.
  faq: {
    tag: 'Häufige Fragen',
    title: 'Was Büros uns fragen.',
    items: [
      {
        q: 'Was ist Piloti?',
        a: 'Piloti ist eine KI-Wissensplattform für Architektur- und Planungsbüros. Sie beantwortet Planungsfragen aus dem geltenden Baurecht, den Unterlagen Ihres Büros und Ihres Projekts und nennt zu jeder Antwort die Quellen. Piloti ist ein Proof of Concept und wird derzeit mit ausgewählten Pilotbüros erprobt.',
      },
      {
        q: 'Für wen ist Piloti gedacht?',
        a: 'Für Architektur- und Planungsbüros in Österreich, die im Alltag Baurecht, OIB-Richtlinien, Normen und Projektunterlagen gegeneinander prüfen müssen, etwa zu Brandschutz, Fluchtwegen oder Energieeffizienz.',
      },
      {
        q: 'Welche Quellen nutzt Piloti?',
        a: 'Die Landesbauordnungen aus dem Rechtsinformationssystem des Bundes (RIS), die OIB-Richtlinien, ein Register der einschlägigen Normen, die Unterlagen Ihres Büros und Ihres Projekts und, wo nötig, eine Web-Recherche, bei der jede Quelle verlinkt ist.',
      },
      {
        q: 'Wie nachvollziehbar sind die Antworten?',
        a: 'Zu jeder Antwort zeigt Piloti die Begründung, die Annahmen, die greifende Vorschrift und den Quellenverweis bis auf Paragraf, Punkt oder Seite. So lässt sich jede Aussage am Original prüfen. Die Verantwortung für die Planung bleibt bei Ihnen, und Piloti ersetzt keine Rechtsberatung.',
      },
      {
        q: 'Trainiert Piloti KI-Modelle mit meinen Daten?',
        a: 'Nein. Wir trainieren keine Modelle mit Ihren Daten, und Pläne und Projektunterlagen bleiben Eigentum Ihres Büros. Dokumente und Antworten können Sie einzeln herunterladen.',
      },
      {
        q: 'Wo werden meine Daten verarbeitet?',
        a: 'Die Anmeldung läuft über WorkOS, Inc. (USA). KI-Anfragen werden über OpenRouter, Inc. (USA) an Modellanbieter weitergeleitet, die ihren Sitz auch außerhalb der EU haben können. Welche Anbieter beteiligt sind, steht in der Datenschutzerklärung.',
      },
      {
        q: 'Was kostet Piloti?',
        a: 'Eine Preisliste gibt es noch nicht. Während der Pilotphase besprechen wir die Bedingungen mit jedem Pilotbüro einzeln. Der Wertrechner auf dieser Seite rechnet mit einem Beispielpreis, nicht mit einem Angebot.',
      },
      {
        q: 'Wer steht hinter Piloti?',
        a: 'Drei Gründer in Wien: {founders}. Piloti ist in Gründung; bis zur Eintragung arbeiten die drei auf Grundlage einer Absichtserklärung (Letter of Intent) zusammen.',
      },
      {
        q: 'Wie wird mein Büro Pilotbüro?',
        a: 'Schreiben Sie uns an {email}. Wir entwickeln Piloti mit wenigen Büros, die es mit echten Planungsfragen aus ihrem Alltag erproben und uns ehrlich sagen, was fehlt.',
      },
    ],
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
    cta: 'Pilotbüro werden',
    langLabel: 'Sprache wählen',
    menu: 'Menü',
    menuOpen: 'Menü öffnen',
    menuClose: 'Menü schließen',
    sectionsLabel: 'Auf dieser Seite',
    sections: [
      { href: '#problem', label: 'Problem und Lösung' },
      { href: '#nutzung', label: 'Nutzung' },
      { href: '#daten', label: 'Datengrundlage' },
      { href: '#ki', label: 'Daten und Transparenz' },
      { href: '#wert', label: 'Wertrechner' },
      { href: '#team', label: 'Team' },
      { href: '#faq', label: 'Häufige Fragen' },
      { href: '#kontakt', label: 'Kontakt' },
    ],
    blog: 'Blog',
    changelog: 'Neuerungen',
  },
  hero: {
    title: 'Planen. Statt suchen.',
    sub: 'Das gesamte Wissen für Ihre Planung. An einem Ort.',
    stage: 'Proof of Concept · Pilotphase mit ausgewählten Büros',
    ctaDemo: 'Pilotbüro werden',
    ctaMore: 'Mehr erfahren',
  },
  story: {
    problemA: 'Architekt:innen gestalten unsere Zukunft,',
    problemB: 'doch das Wissen dafür liegt verstreut.',
    solution:
      'Piloti verknüpft Baurecht, Projektunterlagen und Bürowissen zu einer soliden Wissensbasis.',
    cardTagline: 'Struktur, Verlässlichkeit und Überblick für jede Entwurfsentscheidung.',
    tags: {
      norm: '▸ NORM',
      site: '▸ STANDORT',
      web: '▸ WEB',
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
    body: 'Sie entwerfen, Piloti liefert den Kontext: die Vorschrift, die greift, die Erfahrung aus Ihren früheren Projekten und die Auflagen Ihres Grundstücks — genau das, was Sie brauchen, um die richtige Entscheidung zu treffen.',
    // Measured: the median chat answer takes about 30 seconds.
    big: '≈ 30 s',
    sub: 'typische Antwortzeit — statt Stunden Suche. Mit Verweis auf Paragraf, Richtlinie und Herleitung.',
  },
  daten: {
    tag: 'Datengrundlage',
    title: 'Intelligente Planung auf solider Datenbasis.',
    body: 'Piloti stützt sich auf Quellen, die Sie selbst prüfen können: das geltende Baurecht, die Unterlagen Ihres Büros und Ihres Projekts und, wo nötig, aktuelle Quellen aus dem Web. Jede Aussage lässt sich bis zu ihrem Ursprung zurückverfolgen.',
    // Only sources the product actually has. There is no material or CO₂
    // database, so there is no card for one.
    cards: [
      { title: 'Regelwerke', body: 'Landes\u00adbau\u00adordnungen, OIB-Richtlinien, Normen' },
      { title: 'Ihr Büro', body: 'Pläne, Unterlagen, Erfahrung aus vergangenen Projekten' },
      { title: 'Ihr Projekt', body: 'Standort, Grundstück, Auflagen' },
      { title: 'Web-Recherche', body: 'Aktuelle Quellen, jede mit Link belegt' },
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
      // No residency promise of any kind: model calls may leave the EU. What
      // is stated here is what Piloti itself controls.
      data: [
        { label: 'KI-Training', value: 'Wir trainieren keine Modelle mit Ihren Daten' },
        { label: 'Pläne und Projekte', value: 'Bleiben Eigentum Ihres Büros' },
        { label: 'KI-Modelle', value: 'Anbieter und Standort offen ausgewiesen' },
        { label: 'Downloads', value: 'Dokumente und Antworten jederzeit herunterladbar' },
      ],
      link: 'In der Datenschutzerklärung nachlesen',
    },
    // `lead` is the card in one line, which is all a phone shows; `body` adds
    // the detail from `sm` up.
    cards: [
      {
        title: 'Spezialisiert auf Architektur',
        lead: 'Gebaut für Architektur- und Planungsbüros.',
        body: 'Piloti kennt Landesbauordnungen, OIB-Richtlinien und Normen, versteht Bauteile, Konstruktionen und Typologien und bezieht den konkreten Kontext Ihres Projekts mit ein.',
      },
      {
        title: 'Nachvollziehbar bis zur Quelle',
        lead: 'Jeder Verweis führt zurück zum Ursprung.',
        body: 'Zu jeder Empfehlung sehen Sie Begründung, Annahmen und Regeln. Jeder Verweis führt zu der Stelle, aus der er stammt: zum Paragrafen der Landesbauordnung, zum OIB-Punkt, zur Web-Quelle oder zu Ihrem eigenen Projekt.',
      },
      {
        title: 'Ihre Daten, Ihre Kontrolle',
        lead: 'Ihre Pläne bleiben Ihre Pläne.',
        body: 'Pläne und Projekte bleiben Eigentum Ihres Büros, und wir trainieren keine Modelle mit Ihren Daten. Welche KI-Anbieter Ihre Anfragen verarbeiten, steht in der Datenschutzerklärung. Dokumente und Antworten laden Sie jederzeit einzeln herunter.',
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
    header: 'Piloti · Entscheidungskette',
    fictional: 'Fiktives Beispiel',
    questionLabel: 'Frage',
    sourcesLabel: 'Quellen',
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
    pause: 'Anhalten',
    resume: 'Fortsetzen',
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
      'OIB-RL 6',
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
    tag: 'Neuerungen',
    heading: 'Was sich in Piloti getan hat.',
    intro:
      'Jede Änderung, die Sie in der Anwendung bemerken — neue Funktionen, Verbesserungen, behobene Fehler. Neueste zuerst.',
    empty: 'Noch keine Einträge — die erste Änderung erscheint hier, sobald sie ausgeliefert ist.',
    unreleased: 'In Kürze',
    versionLabel: 'Version',
  },
  notFound: {
    heading: 'Diese Seite liegt nicht im Plan.',
    body: 'Die gesuchte Seite existiert nicht oder wurde verschoben.',
    home: 'Zur Startseite',
  },
  legal: {
    tag: 'Rechtliches',
    emailLabel: 'E-Mail',
    updated: 'Stand: September 2026',
    impressum: {
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
    title: 'AI for architecture and planning firms in Austria — Piloti',
    description:
      'Piloti is the AI knowledge platform for architecture and planning firms in Austria: answers on building law, OIB guidelines and project documents, with sources.',
  },
  seo: {
    pages: {
      blog: {
        title: 'Blog: building law, planning practice and AI — Piloti',
        description:
          'The Journal for architecture and planning offices and the build log from development: Austrian building law, OIB guidelines and how Piloti is built.',
      },
      journal: {
        title: 'Journal: building law and planning practice — Piloti Blog',
        description:
          'For architecture and planning offices: Austrian building law made readable, OIB guidelines and state building codes in context, and what AI changes at work.',
      },
      bautagebuch: {
        title: 'Build log: notes from development — Piloti Blog',
        description:
          'How Piloti is built, and why: notes from developing an AI knowledge platform for building law, project documents and office knowledge, written in Vienna.',
      },
      changelog: {
        title: "What's new: features and improvements — Piloti",
        description:
          'What changed in Piloti: new features, improvements and fixes to the AI knowledge platform for architecture and planning firms, updated continuously.',
      },
      rechenweg: {
        title: 'The maths behind the Piloti value calculator — Piloti',
        description:
          'Every step behind the Piloti example calculation: our assumptions, your numbers, an example price, and what the calculation leaves out.',
      },
      impressum: {
        title: 'Imprint — Piloti',
        description:
          'Imprint and disclosure for the Piloti website under Austrian law (§ 5 ECG, § 25 MedienG): who is behind Piloti, where we are based and how to reach us.',
      },
      datenschutz: {
        title: 'Privacy policy — Piloti',
        description:
          'How the Piloti website handles your data: no cookies, no tracking, which services are involved, and which providers the Piloti application relies on.',
      },
      notFound: {
        title: 'Page not found — Piloti',
        description: 'This page does not exist or has been moved.',
      },
    },
    postTitleSuffix: ' — Piloti',
    ogImageAlt: 'Piloti: Plan. Instead of searching. AI for architecture and planning firms.',
    breadcrumbHome: 'Home',
    byline: 'By',
    and: 'and',
    rssTitle: 'Piloti Blog',
    rssDescription:
      "Piloti's Journal and build log: building law, planning practice and the development of an AI knowledge platform for architecture firms.",
    llmsPages: 'Pages (English)',
    llmsPosts: 'Blog (English)',
    llmsFacts: 'Built in Vienna by {founders}. Contact: {email}.',
  },
  faq: {
    tag: 'Questions',
    title: 'What offices ask us.',
    items: [
      {
        q: 'What is Piloti?',
        a: 'Piloti is an AI knowledge platform for architecture and planning firms. It answers planning questions from the building law in force and from your office and project documents, and names the sources for every answer. Piloti is a proof of concept, currently being trialled with a small number of pilot offices.',
      },
      {
        q: 'Who is Piloti for?',
        a: 'For architecture and planning firms in Austria that spend their days checking building law, OIB guidelines, standards and project documents against each other, for example on fire safety, escape routes or energy efficiency.',
      },
      {
        q: 'Which sources does Piloti use?',
        a: "The Austrian states' building codes from the federal legal information system (RIS), the OIB guidelines, a register of the relevant standards, your office and project documents and, where needed, web research in which every source is linked.",
      },
      {
        q: 'How traceable are the answers?',
        a: 'With every answer Piloti shows the reasoning, the assumptions, the rule that applies and the source reference down to the section, clause or page, so every statement can be checked against the original. Responsibility for the design stays with you, and Piloti is not legal advice.',
      },
      {
        q: 'Does Piloti train AI models on my data?',
        a: 'No. We do not train models on your data, and drawings and project documents remain the property of your office. You can download documents and answers individually.',
      },
      {
        q: 'Where is my data processed?',
        a: 'Sign-in runs through WorkOS, Inc. (USA). AI requests are routed through OpenRouter, Inc. (USA) to model providers that may be based outside the EU. The privacy policy lists which providers are involved.',
      },
      {
        q: 'What does Piloti cost?',
        a: 'There is no price list yet. During the pilot phase we agree terms with each pilot office individually. The value calculator on this page uses an example price, not an offer.',
      },
      {
        q: 'Who is behind Piloti?',
        a: 'Three founders in Vienna: {founders}. Piloti is being founded; until it is registered, the three work together under a letter of intent.',
      },
      {
        q: 'How does my office become a pilot office?',
        a: 'Write to us at {email}. We are building Piloti with a few offices that try it on real planning questions from their daily work and tell us honestly what is missing.',
      },
    ],
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
    cta: 'Become a pilot office',
    langLabel: 'Choose language',
    menu: 'Menu',
    menuOpen: 'Open menu',
    menuClose: 'Close menu',
    sectionsLabel: 'On this page',
    sections: [
      { href: '#problem', label: 'Problem and solution' },
      { href: '#nutzung', label: 'Usage' },
      { href: '#daten', label: 'Data foundation' },
      { href: '#ki', label: 'Data and transparency' },
      { href: '#wert', label: 'Value calculator' },
      { href: '#team', label: 'Team' },
      { href: '#faq', label: 'Questions' },
      { href: '#kontakt', label: 'Contact' },
    ],
    blog: 'Blog',
    changelog: "What's new",
  },
  hero: {
    title: 'Plan. Instead of searching.',
    sub: 'All the knowledge for your planning. In one place.',
    stage: 'Proof of concept · Pilot phase with selected offices',
    ctaDemo: 'Become a pilot office',
    ctaMore: 'Learn more',
  },
  story: {
    problemA: 'Architects shape our future,',
    problemB: 'yet the knowledge it takes is scattered.',
    solution:
      'Piloti connects building law, project documents and office knowledge into one solid knowledge base.',
    cardTagline: 'Structure, reliability and clarity for every design decision.',
    tags: {
      norm: '▸ NORM',
      site: '▸ SITE',
      web: '▸ WEB',
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
    body: 'You design, Piloti delivers the context: the regulation that applies, the experience from your past projects and the conditions on your plot — exactly what you need to make the right decision.',
    big: '≈ 30 s',
    sub: 'typical response time — instead of hours of searching. With references to the clause, the guideline and the derivation.',
  },
  daten: {
    tag: 'Data foundation',
    title: 'Intelligent planning on a solid data foundation.',
    body: 'Piloti draws on sources you can check yourself: the building law in force, the documents of your office and your project and, where needed, current sources from the web. Every statement can be traced back to its origin.',
    cards: [
      { title: 'Regulations', body: 'State building codes, OIB guidelines, standards' },
      { title: 'Your office', body: 'Plans, documents, experience from past projects' },
      { title: 'Your project', body: 'Site, plot, official requirements' },
      { title: 'Web research', body: 'Current sources, each backed by a link' },
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
        { label: 'AI training', value: 'We do not train models on your data' },
        { label: 'Plans and projects', value: 'Remain the property of your office' },
        { label: 'AI models', value: 'Providers and location disclosed openly' },
        { label: 'Downloads', value: 'Documents and answers downloadable at any time' },
      ],
      link: 'Read it in the privacy policy',
    },
    cards: [
      {
        title: 'Specialised in architecture',
        lead: 'Built for architecture and planning offices.',
        body: 'Piloti knows state building codes, OIB guidelines and standards, understands components, constructions and typologies, and factors in the concrete context of your project.',
      },
      {
        title: 'Traceable to the source',
        lead: 'Every reference leads back to its origin.',
        body: 'Every recommendation shows its reasoning, assumptions and rules. Every reference leads to the place it came from: the clause of the state building code, the OIB section, the web source or your own project.',
      },
      {
        title: 'Your data, your control',
        lead: 'Your plans remain your plans.',
        body: 'Plans and projects remain the property of your office, and we do not train models on your data. The privacy policy names the AI providers that process your requests. You can download documents and answers individually at any time.',
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
    questionLabel: 'Question',
    sourcesLabel: 'Sources',
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
    pause: 'Pause',
    resume: 'Resume',
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
      'U-VALUE',
      null,
      'OIB-RL 6',
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
    tag: "What's new",
    heading: 'What has changed in Piloti.',
    intro:
      'Every change you can notice in the product — new features, improvements, fixes. Newest first.',
    empty: 'Nothing here yet — the first change appears the day it ships.',
    unreleased: 'Coming up',
    versionLabel: 'Version',
  },
  notFound: {
    heading: 'This page is not in the plan.',
    body: 'The page you are looking for does not exist or has been moved.',
    home: 'Back to the homepage',
  },
  legal: {
    tag: 'Legal',
    emailLabel: 'Email',
    updated: 'Last updated: September 2026',
    impressum: {
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
