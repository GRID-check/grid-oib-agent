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
    title: 'KI für Architektur- und Planungsbüros in Österreich – Piloti',
    description:
      'Piloti ist eine KI-Wissensplattform für Architektur- und Planungsbüros in Österreich: Antworten zu Baurecht, OIB-Richtlinien und Projektunterlagen, mit Quellen.',
  },
  // Every other page's <title> and meta description, and what the head needs
  // around them. Titles stay near 60 characters, descriptions near 155.
  seo: {
    pages: {
      blog: {
        title: 'Blog: Baurecht, Planungspraxis und KI im Büro – Piloti',
        description:
          'Das Journal für Architektur- und Planungsbüros und das Bautagebuch aus der Entwicklung: Baurecht in Österreich, OIB-Richtlinien und wie Piloti gebaut ist.',
      },
      journal: {
        title: 'Journal: Baurecht und Planungspraxis für Büros – Piloti Blog',
        description:
          'Für Architektur- und Planungsbüros: Baurecht in Österreich verständlich, OIB-Richtlinien und Landesbauordnungen eingeordnet, und was KI im Büroalltag ändert.',
      },
      bautagebuch: {
        title: 'Bautagebuch: Notizen aus der Entwicklung – Piloti Blog',
        description:
          'Wie Piloti gebaut ist und warum: Notizen aus der Entwicklung einer KI-Wissensplattform für Baurecht, Projektunterlagen und Bürowissen, geschrieben in Wien.',
      },
      changelog: {
        title: 'Neuerungen: neue Funktionen und Verbesserungen – Piloti',
        description:
          'Was sich in Piloti geändert hat: neue Funktionen, Verbesserungen und Fehlerbehebungen der KI-Wissensplattform für Architekturbüros, laufend aktualisiert.',
      },
      rechenweg: {
        title: 'Rechenweg: So rechnet der Piloti-Wertrechner – Piloti',
        description:
          'Jeder Schritt hinter der Beispielrechnung von Piloti: unsere Annahmen, Ihre Zahlen, ein Beispielpreis, und was die Rechnung bewusst weglässt.',
      },
      impressum: {
        title: 'Impressum – Piloti',
        description:
          'Impressum und Offenlegung der Piloti-Website nach §\u00a05 ECG und §\u00a025 MedienG: wer hinter Piloti steht, wo wir sitzen und wie Sie uns erreichen.',
      },
      datenschutz: {
        title: 'Datenschutzerklärung – Piloti',
        description:
          'Wie die Piloti-Website mit Ihren Daten umgeht: keine Cookies, kein Tracking, welche Dienste beteiligt sind und welche Anbieter die Piloti-Anwendung nutzt.',
      },
      mailInbox: {
        title: 'E-Mail-Eingang: Dateien per E-Mail ins Projekt – Piloti',
        description:
          'Jedes Projekt in Piloti hat eine eigene E-Mail-Adresse. Wer senden darf, was mit Anhängen passiert, warum eine E-Mail zurückkommt und wie Sie DKIM einschalten.',
      },
      kontakt: {
        title: 'Kontakt: Planungsfrage schicken oder Gespräch anfragen – Piloti',
        description:
          'Schreiben Sie den Gründern von Piloti: eine Planungsfrage aus Ihrem Projekt, eine Frage zur Pilotphase oder ein Gesprächswunsch. Wir antworten per E-Mail.',
      },
      warum: {
        title: 'Warum Piloti: KI für Architekturbüros in Österreich',
        description:
          'Warum nicht einfach ChatGPT? Piloti verbindet österreichisches Baurecht, Ihre Pläne und Ihr Bürowissen zu Antworten mit prüfbaren Quellen, bis in den Akt.',
      },
      notFound: {
        title: 'Seite nicht gefunden – Piloti',
        description: 'Diese Seite existiert nicht oder wurde verschoben.',
      },
    },
    postTitleSuffix: ' – Piloti',
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
        a: 'Piloti ist eine KI-Wissensplattform für Architektur- und Planungsbüros. Sie beantwortet Planungsfragen aus dem geltenden Baurecht, den Unterlagen Ihres Büros und Ihres Projekts und nennt zu jeder Antwort die Quellen. Es übernimmt auch Arbeit, die länger dauert als eine Antwort: Prüfberichte und Aktenvermerke im Projekt, offene Punkte und wiederkehrende Checks. Piloti ist ein Proof of Concept und wird derzeit mit ausgewählten Pilotbüros erprobt.',
      },
      {
        q: 'Warum nicht einfach ChatGPT?',
        a: 'ChatGPT beantwortet Fragen. Piloti beantwortet sie im Zusammenhang Ihres Projekts: aus den Landesbauordnungen im RIS, den OIB-Richtlinien, Ihren Plänen und dem Archiv Ihres Büros, mit einer Fundstelle bis auf Paragraf, Punkt oder Seite, die vor dem Anzeigen gegen den Quelltext geprüft wird. Fehlt eine Unterlage, etwa der Bebauungsplan, sagt Piloti das, statt zu antworten, als hätte es sie gelesen.',
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
        a: 'Zu jeder Antwort zeigt Piloti die Begründung, die Annahmen, die greifende Vorschrift und den Quellenverweis bis auf Paragraf, Punkt oder Seite. So können Sie die Antwort am Original prüfen. Die Verantwortung für die Planung bleibt bei Ihnen, und Piloti ersetzt keine Rechtsberatung.',
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
        a: 'Schicken Sie uns an {email} eine echte Planungsfrage aus einem laufenden Projekt. Wir zeigen Ihnen, wie Piloti sie beantwortet. Wir entwickeln Piloti mit wenigen Büros, die es mit echten Planungsfragen aus ihrem Alltag erproben und uns ehrlich sagen, was fehlt.',
      },
    ],
  },
  skipLink: 'Zum Inhalt springen',
  // Drawing-set index shown in the page margin (see SheetIndex.astro).
  sheets: {
    hero: '01 Start',
    story: '02 Problem und Lösung',
    nutzung: '03 Nutzung',
    arbeit: '04 Arbeit übergeben',
    daten: '05 Quellen und Daten',
    wert: '06 Wert',
    team: '07 Team',
    faq: '08 Häufige Fragen',
    kontakt: '09 Kontakt',
  },
  nav: {
    ariaLabel: 'Hauptnavigation',
    logoLabel: 'Piloti, Startseite',
    signIn: 'Anmelden',
    signInPending: 'Weiterleitung…',
    cta: 'Frage mitbringen',
    why: 'Warum Piloti',
    compare: 'Vergleiche',
    langLabel: 'Sprache wählen',
    menu: 'Menü',
    menuOpen: 'Menü öffnen',
    menuClose: 'Menü schließen',
    sectionsLabel: 'Auf dieser Seite',
    sections: [
      { href: '#problem', label: 'Problem und Lösung' },
      { href: '#nutzung', label: 'Nutzung' },
      { href: '#arbeit', label: 'Arbeit übergeben' },
      { href: '#daten', label: 'Quellen und Daten' },
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
    sub: 'Baurecht, Büro- und Projektwissen. An einem Ort.',
    stage: 'Proof of Concept · Pilotphase mit ausgewählten Büros',
    ctaDemo: 'Mit einer echten Frage testen',
    ctaMore: 'Mehr erfahren',
  },
  story: {
    problemA: 'Architekt:innen gestalten unsere Zukunft,',
    problemB: 'doch das Wissen dafür liegt verstreut.',
    solution:
      'Piloti verknüpft Baurecht, Projektunterlagen und Bürowissen zu einer Wissensbasis.',
    cardTagline: 'Die Stelle im Gesetz, der Plan von 2019, die Auflage vom Amt. In einer Antwort.',
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
    title: 'Zu jeder Planungsaufgabe das passende Wissen.',
    body: 'Sie entwerfen, Piloti liefert den Kontext: die Vorschrift, die greift, die Erfahrung aus Ihren früheren Projekten und die Auflagen Ihres Grundstücks. Die Entscheidung treffen Sie.',
    // Measured: the median chat answer takes about 30 seconds.
    big: '≈\u202f30\u00a0s',
    sub: 'gemessene typische Antwortzeit',
    // The chat beside this is a fictional example; the post is the real thing.
    howLead: 'Wie eine Antwort entsteht:',
    howLabel: 'Wie Piloti funktioniert',
    howHref: '/blog/wie-piloti-funktioniert/',
  },
  // The handover: the step from an answer to work done. A fictional project,
  // but every step is a shipped feature, in the changelog's own words where it
  // has them (the task line, the finding count, the review actions).
  arbeit: {
    title: 'Übergeben Sie Arbeit. Nicht nur Fragen.',
    body: 'Ein Nachschlagewerk wartet, bis Sie fragen. Piloti nimmt Aufträge an: Es recherchiert in Plänen und Vorschriften, legt den Bericht ins Projekt, macht aus Befunden offene Punkte und prüft wieder, wenn Sie es wollen.',
    label: 'Fiktives Projekt · jeder Schritt eine ausgelieferte Funktion',
    boardLabel: 'Eine Woche mit Piloti, fiktives Beispiel',
    close: 'Fristen, Befunde und Freigaben bleiben im Projekt, für das ganze Team sichtbar. Das ist der Unterschied zwischen einem Werkzeug, das antwortet, und einem, das mitarbeitet.',
    link: 'Jede Funktion im Changelog',
    status: { ok: 'erfüllt', open: 'offen' },
    steps: {
      ask: {
        when: 'Mo · Sie im Chat',
        quote: '„Mach den Einreichcheck für den Wohnbau 1030 bis Freitag.“',
        note: 'Ein Satz genügt. Daraus wird ein Auftrag, unter Ihrem Namen und mit Ihren Rechten.',
      },
      run: {
        when: 'Mo · Auftrag läuft',
        title: 'Einreichcheck · Wohnbau 1030',
        line: 'Recherchieren · 3\u00a0Runden · 9\u00a0Dokumente',
        note: 'Liest Pläne, Bescheid und Bebauungsplan des Projekts und die geltenden Vorschriften. Sie fragen im selben Chat weiter.',
      },
      report: {
        when: 'Mo · Bericht im Projekt',
        title: 'Prüfbericht Einreichung',
        summary: '2 erfüllt · 1 offen',
        rows: [
          { req: 'Fluchtwege', ok: true },
          { req: 'Stellplätze', ok: true },
          { req: 'Brandschutzschott Fassade', ok: false },
        ],
        note: 'Urteil zuerst, dann eine Zeile je Anforderung, mit Fundstelle. Abgelegt unter „Berichte“.',
      },
      open: {
        when: 'Di · Offener Punkt',
        title: 'Schott im Fassadenschnitt fehlt',
        action: 'Klären',
        note: 'Aus dem Befund wird ein eigener Auftrag. Im Projektgedächtnis bleibt er offen, bis er geklärt ist.',
      },
      review: {
        when: 'Do · Posteingang',
        title: 'Prüfbericht zur Freigabe',
        approve: 'Freigeben',
        changes: 'Änderungen anfordern',
        note: 'Die Projektleitung gibt frei oder schickt zurück, und Piloti überarbeitet anhand der Begründung.',
      },
      repeat: {
        when: 'Ab jetzt · Zeitplan',
        quote: '„Prüf das jeden Montag.“',
        note: 'Der Check läuft jede Woche wieder, und das Ergebnis kommt in Ihren Posteingang.',
      },
    },
  },
  daten: {
    title: 'Quellen, die Sie prüfen können.',
    body: 'Die Verantwortung für die Planung bleibt bei Ihnen.',
    // The list's accessible name; the heading above says the rest.
    sourcesLabel: 'Worauf Piloti sich stützt',
    // Only sources the product actually has. There is no material or CO₂
    // database, so there is no card for one.
    cards: [
      { title: 'Regelwerke', body: 'Landes\u00adbau\u00adordnungen, OIB-Richtlinien, Normen\u00adverzeichnis' },
      { title: 'Ihr Büro', body: 'Pläne, Unterlagen, Erfahrung aus vergangenen Projekten' },
      { title: 'Ihr Projekt', body: 'Standort, Grundstück, Auflagen' },
      { title: 'Web-Recherche', body: 'Aktuelle Quellen, jede mit Link belegt' },
    ],
    proof: {
      answerHeading: 'Zu jeder Antwort',
      answer: [
        { label: 'Begründung', value: 'warum die Antwort so lautet' },
        { label: 'Annahmen', value: 'worauf sie beruht' },
        { label: 'Regeln', value: 'welche Vorschrift greift' },
        { label: 'Quellenverweis', value: 'Paragraf, Punkt, Seite' },
      ],
      dataHeading: 'Zu Ihren Daten',
      // No residency promise of any kind: model calls may leave the EU. The
      // first three lines are what Piloti itself controls; the last says where
      // the data goes, in the privacy policy's words and no further.
      data: [
        'Wir trainieren keine Modelle mit Ihren Daten.',
        'Pläne und Projekte bleiben Eigentum Ihres Büros.',
        'Dokumente und Antworten laden Sie einzeln herunter.',
        'Anmeldung über WorkOS (USA). KI-Anfragen laufen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können.',
      ],
      link: 'Details in der Datenschutzerklärung',
    },
  },
  roi: {
    title: 'Rechnen Sie selbst nach.',
    body: 'Wir nehmen an, dass rund 30\u00a0% einer Planungswoche in die Suche gehen, nach Normen, Vorprojekten und Kennwerten, und dass Piloti davon 40\u00a0% zurückgibt. Gemessen hat das noch niemand. Setzen Sie Ihr Büro und einen Beispielpreis ein und sehen Sie, was die Annahme wert wäre.',
    fields: {
      seats: 'Planer:innen mit Piloti',
      salary: 'Durchschnittliches Bruttojahresgehalt',
      price: 'Beispielpreis je Platz und Monat',
    },
    stepDown: 'Einen Platz weniger',
    stepUp: 'Einen Platz mehr',
    salaryNote: 'je Person, mit 13. und 14. Gehalt, ohne Lohnnebenkosten',
    claimsLabel: 'Unsere Annahmen',
    claims: {
      week: 'Arbeitswoche',
      research: 'Anteil Recherche',
      saved: 'Davon gibt Piloti zurück',
    },
    resultLabel: 'Jahreswert · Beispiel',
    resultNote: 'netto nach Beispielpreis, für Ihr ganzes Büro, wenn die Annahmen zutreffen',
    metrics: {
      hours: 'Zurückgewonnene Zeit',
      payback: 'Amortisiert nach',
      ratio: 'Wert je Euro',
    },
    footnote:
      'Eine Beispielrechnung aus unseren Annahmen, Ihren Zahlen und einem Beispielpreis. Kein Angebot und keine Zusage. Jeder Schritt steht im',
    footnoteLink: 'ganzen Rechenweg',
    units: {
      hours: '{value}\u00a0h/Jahr',
      hoursPlain: '{value}\u00a0h',
      perHour: '{value}/h',
      times: '×\u00a0{value}',
      perYear: '12\u00a0×\u00a0{value}',
      minus: '−{value}',
      fte: '≈\u202f{value} Vollzeitstellen',
      months: '{value}\u00a0Monate',
      ratio: '{value}×',
      never: '–',
      approx: '≈\u202f{value}',
      seatsSpoken: '{value} Planer:innen',
      office:
        'Diese Rechnung gilt für {seats} Plätze, ein durchschnittliches Bruttojahresgehalt von {salary} und einen Beispielpreis von {price} je Platz und Monat.',
      officeOne:
        'Diese Rechnung gilt für einen Platz, ein durchschnittliches Bruttojahresgehalt von {salary} und einen Beispielpreis von {price} je Platz und Monat.',
    },
  },
  rechenweg: {
    back: 'Zahlen ändern',
    title: 'Die ganze Rechnung, offen.',
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
      bracket: 'Recherche: 30\u00a0% der Woche',
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
      'Diese Zahlen sind Annahmen, keine Messwerte aus Kundenprojekten. Auch der Preis ist ein Beispiel, kein Angebot. Liegt Ihre Recherchezeit bei 20\u00a0%, halbiert sich der Wert je Platz fast.',
  },
  team: {
    title: 'Drei Gründer, ein Ziel: Wissen dort, wo geplant wird.',
    body: 'Architektur, Software und Vertrieb an einem Tisch. Wir bauen Piloti gemeinsam mit unseren Pilotbüros, an ihren echten Fragen.',
    listLabel: 'Die Gründer',
  },
  cta: {
    title: 'Bringen Sie eine echte Frage mit.',
    body: 'Schicken Sie uns eine Planungsfrage aus einem laufenden Projekt, gern mit den Unterlagen dazu. Wir zeigen Ihnen, wie Piloti sie beantwortet, mit Quellen, die Sie am Original prüfen. Passt es, planen Sie als Pilotbüro mit: früher Zugang, ein direkter Draht zu uns Gründern und Einfluss darauf, was wir als Nächstes bauen.',
    primary: 'Mit einer echten Frage testen',
    stepsLabel: 'So geht es weiter',
    steps: [
      { title: 'Sie schicken eine Frage', body: 'Eine echte aus Ihrem Projekt, dazu Ort und Gebäudeart. Unterlagen, wenn Sie mögen.' },
      { title: 'Wir zeigen die Antwort', body: 'Im Gespräch, mit Ihren Unterlagen und den Quellen, die Piloti dafür heranzieht.' },
      { title: 'Sie planen mit Piloti', body: 'Als Pilotbüro, mit Ihren Fragen aus dem Alltag, und Sie sagen uns, was fehlt.' },
    ],
    subjectPilot: 'Planungsfrage für Piloti',
    bodyPilot:
      'Guten Tag,\n\nhier ist eine Frage aus einem unserer Projekte.\n\nUnsere Frage:\nBundesland und Ort:\nGebäudeart (z.\u00a0B. Wohnbau, Schule, Bestand):\nBüro und Planer:innen im Team:\n\n',
  },
  // The contact form (ContactForm.astro), in the #kontakt section and on
  // /kontakt/. `{email}` becomes a mailto link, `{max}` the field's limit.
  contact: {
    label: 'Kontaktformular',
    name: 'Name',
    email: 'E-Mail',
    office: 'Büro oder Firma',
    optional: 'optional',
    message: 'Ihre Nachricht',
    messageHint: 'Eine Planungsfrage aus einem laufenden Projekt, mit Ort und Gebäudeart, oder ein Terminwunsch für ein Gespräch.',
    submit: 'Nachricht senden',
    sending: 'Wird gesendet …',
    privacy: 'Wir verwenden Ihre Angaben, um Ihre Anfrage zu beantworten. Mehr dazu in der {link}.',
    privacyLink: 'Datenschutzerklärung',
    alternative: 'Mit Unterlagen, oder lieber per E-Mail: {email}',
    honeypot: 'Dieses Feld bitte leer lassen',
    errors: {
      required: 'Bitte füllen Sie dieses Feld aus.',
      email: 'Bitte geben Sie eine gültige E-Mail-Adresse an.',
      too_long: 'Bitte kürzen Sie auf höchstens {max} Zeichen.',
    },
    status: {
      sent: 'Danke, Ihre Nachricht ist angekommen. Wir antworten Ihnen per E-Mail.',
      invalid: 'Bitte prüfen Sie die markierten Felder.',
      retry: 'Bitte senden Sie die Nachricht noch einmal ab. Ihre Angaben sind noch da.',
      rateLimited: 'Von Ihrer Verbindung kamen gerade mehrere Nachrichten. Versuchen Sie es in zehn Minuten wieder oder schreiben Sie direkt an {email}.',
      failed: 'Die Nachricht ließ sich gerade nicht senden. Schreiben Sie uns bitte direkt an {email}.',
    },
    pageHeading: 'Schreiben Sie uns.',
    pageLede: 'Eine Planungsfrage, eine Frage zur Pilotphase oder ein Gesprächswunsch: Die Nachricht geht direkt an uns Gründer.',
  },
  // The one line that closes a subpage (EndInvite), before the footer. Each
  // says only what the landing page already stands behind.
  invite: {
    blog: 'Wir entwickeln Piloti mit wenigen Pilotbüros. Soll Ihres dabei sein, schreiben Sie uns.',
    changelog: 'Was hier als Nächstes steht, bestimmen die Pilotbüros mit.',
    rechenweg: 'Gemessen hat das noch niemand. Messen wir es in Ihrem Büro.',
    warum: 'Die beste Probe ist eine Frage aus Ihrem laufenden Projekt. Schicken Sie uns eine.',
    mailInbox: 'Die Pläne kommen per E-Mail, die Fragen dazu beantwortet Piloti. Schicken Sie uns eine aus Ihrem laufenden Projekt.',
  },
  chat: {
    fictional: 'Fiktives Beispiel',
    question:
      'Ich will das Stiegenhaus ins Freie führen und über eine gedämmte Loggia-Fassade erschließen. Was heißt das brandschutztechnisch?',
    oibTitle: 'Pkt.\u00a03.5 – Fassaden',
    oibSub: 'Brandausbreitung über die Außenwand, GK\u00a04',
    boTitle: '§\u00a0106 – Fluchtwege',
    boSub: 'Stiegenhaus ins Freie, zweiter Rettungsweg',
    projTag: 'Projekt',
    projSub: 'WDVS 14\u00a0cm EPS, Loggia über 2\u00a0Geschoße',
    decisionIntro: 'Für Ihr WDVS (GK\u00a04) haben Sie drei Wege:',
    optATitle: 'Loggia in A2',
    optASub: 'übrige Fassade EPS ≤\u202f10\u00a0cm',
    optBTitle: 'EPS >\u202f10\u00a0cm mit Schott',
    optBSub: 'Brandschutzschott je Geschoß',
    optCTitle: 'Mit der Behörde klären',
    optCSub: 'Loggia als „offener Durchgang“',
    impl: 'Umsetzung – B',
    steps: [
      'Schott je Geschoß im Fassadenschnitt eintragen',
      'Nachweis OIB-RL\u00a02, Pkt.\u00a03.5 der Einreichung beilegen',
      'Mehrkosten 4.200\u00a0€ in die Kostenschätzung übernehmen',
    ],
    resume: 'Fortsetzen',
  },
  chain: {
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
  // The decision chain on phones, told one step per frame (ChainStories).
  // Question, sources, options and steps are read from `chat`; only what the
  // story adds lives here. The clause gists are paraphrases written for the
  // fictional example, not quotations.
  stories: {
    region: 'Entscheidungskette, fiktives Beispiel',
    leads: [
      'Sie fragen, wie Sie eine Kollegin fragen würden.',
      'Piloti findet die Stellen, die gelten: im Baurecht und in Ihren Plänen.',
      'Piloti zeigt die möglichen Wege und begründet sie. Sie wählen.',
      'Aus Ihrer Wahl werden die nächsten Schritte, bis in die Kostenschätzung.',
    ],
    frames: ['Frage', 'Quellen', 'Entscheidung', 'Umsetzung'],
    stepOf: 'Schritt {n} von {total}: {name}',
    prev: 'Vorheriger Schritt',
    next: 'Nächster Schritt',
    pause: 'Anhalten',
    play: 'Abspielen',
    replay: '↻ Nochmal',
    flipHint: 'Karte antippen: Auszug',
    context: [
      ['Projekt', 'Wohnbau, Wien 1030'],
      ['Gebäudeklasse', 'GK\u00a04'],
      ['Gefragt von', 'Projektleitung'],
    ],
    gistLabel: 'Sinngemäß, fiktiv',
    gists: [
      'EPS über 10\u00a0cm bei GK\u00a04 nur mit einem umlaufenden Brandschutzschott in jedem Geschoß.',
      'Ein ins Freie geführtes Stiegenhaus bleibt rauchfrei; die Loggia bleibt offen.',
      'Schnitt A–A: 14\u00a0cm EPS über 1. und 2. OG, kein Schott eingetragen.',
    ],
    whyHint: 'Weg antippen: Begründung',
    why: [
      'Nicht gewählt: Material teurer, die Fassade wird zweigeteilt.',
      'Gewählt: hält GK\u00a04 ein, die Dämmstärke bleibt.',
      'Nicht gewählt: Ausgang offen, das Verfahren verzögert sich.',
    ],
    complete: 'Vollständige Kette',
    cost: '≈\u202f4.200\u00a0€ in die Kostenschätzung',
  },
  footer: {
    ariaLabel: 'Footer',
    tagline: 'KI für Architektur- und Planungsbüros. Entwickelt in Wien.',
    productHeading: 'Produkt',
    companyHeading: 'Mehr erfahren',
    legalHeading: 'Rechtliches',
    contactHeading: 'Kontakt',
    contactBody: 'Fragen, Einwände oder Interesse an der Pilotphase?',
    usage: 'Nutzung',
    data: 'Quellen und Daten',
    value: 'Wertrechner',
    working: 'Rechenweg',
    mailInbox: 'E-Mail-Eingang',
    team: 'Team',
    why: 'Warum Piloti',
    blog: 'Blog',
    changelog: 'Neuerungen',
    privacy: 'Datenschutz',
    imprint: 'Impressum',
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
    heading: 'Aus dem Büro und von der Baustelle.',
    filterLabel: 'Beiträge nach Kategorie',
    filterAll: 'Alle',
    categoryLabel: 'Kategorie',
    entry: 'Eintrag',
    empty: 'Noch keine Beiträge. Der erste Artikel ist in Arbeit.',
    allPosts: '← Alle Beiträge',
  },
  // The changelog page. Its ENTRIES are not here: they come from
  // src/data/changelog.json, generated from releasenotes/notes/ on merge — see
  // docs/contributing/release-notes.md. Only the page chrome is translated here.
  changelog: {
    heading: 'Was sich in Piloti getan hat.',
    empty: 'Noch keine Einträge. Die erste Änderung erscheint hier, sobald sie ausgeliefert ist.',
    unreleased: 'In Kürze',
    versionLabel: 'Version',
    olderHeading: 'Frühere Neuerungen',
    buildHeading: 'Bauverlauf',
    weekShort: 'KW\u00a0{n}',
    monthCount: '{count} Wochen',
    monthCountOne: '1 Woche',
  },
  notFound: {
    heading: 'Diese Seite liegt nicht im Plan.',
    body: 'Die gesuchte Seite existiert nicht oder wurde verschoben.',
    home: 'Zur Startseite',
    blog: 'Zum Blog',
  },
  legal: {
    emailLabel: 'E-Mail',
    updated: 'Stand: September 2026',
    impressum: {
      heading: 'Impressum',
      ownerHeading: 'Medieninhaber, Herausgeber und Diensteanbieter',
      legalForm: 'Gesellschaft bürgerlichen Rechts (GesbR)',
      brand: 'auftretend unter der Projektbezeichnung „Piloti“',
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
          id: 'kontakt',
          heading: 'Kontaktformular und E-Mail',
          html: 'Schreiben Sie uns über das Kontaktformular oder an <a href="mailto:kontakt@piloti.at">kontakt@piloti.at</a>, verarbeiten wir Ihre Angaben (Name, E-Mail-Adresse, Büro oder Firma, falls angegeben, und Ihre Nachricht), um Ihre Anfrage zu beantworten. Rechtsgrundlage ist Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO, soweit Ihre Anfrage einen Vertrag oder dessen Anbahnung betrifft, sonst unser berechtigtes Interesse, Anfragen zu beantworten (lit.&nbsp;f). Zum Schutz vor Missbrauch wird beim Absenden des Formulars Ihre IP-Adresse verarbeitet: Wir zählen Absendungen je Adresse höchstens zehn Minuten lang im Arbeitsspeicher. Die IP-Adresse wird nicht gespeichert und nicht mit Ihrer Nachricht übermittelt. Die Nachricht aus dem Formular stellt Cloudflare, Inc. (USA) per E-Mail zu, und Mails an kontakt@piloti.at leitet Cloudflare weiter; Cloudflare ist unter dem EU-US Data Privacy Framework zertifiziert (Art.&nbsp;45 DSGVO). Beides landet in den E-Mail-Postfächern der Gründer; auf dieser Website wird nichts davon gespeichert. Wir löschen Ihre Nachricht, sobald Ihre Anfrage erledigt ist, spätestens nach zwölf Monaten, es sei denn, es kommt ein Vertrag zustande.',
        },
        {
          heading: 'Anmeldung und Piloti-Anwendung',
          html: 'Mit „Anmelden“ verlassen Sie diese Website und gelangen zur Piloti-Anwendung; dort gilt deren eigene Datenschutzerklärung. Kurz vorab: Die Anmeldung läuft über WorkOS, Inc. (USA). KI-Anfragen werden über OpenRouter, Inc. (USA) an Modellanbieter weitergeleitet, die ihren Sitz auch außerhalb der EU haben können. E-Mails an die E-Mail-Adresse eines Projekts nimmt Cloudflare, Inc. (USA) entgegen und reicht sie an die Anwendung weiter; lehnt die Anwendung eine solche E-Mail ab, verarbeiten wir sie nur, um sie abzulehnen, und speichern nichts davon (berechtigtes Interesse, Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;f DSGVO). Wir selbst trainieren keine KI-Modelle mit Ihren Daten.',
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
  // The unlisted image page (src/lib/unlisted.ts): every riso file to
  // download. Group names are keyed by work, format labels by format stem;
  // a work or format without a label here shows its id.
  bildmaterial: {
    title: 'Bildmaterial – Piloti',
    description: 'Alle Risografien von Piloti zum Herunterladen.',
    heading: 'Bildmaterial',
    all: 'Alles als ZIP',
    zip: 'ZIP',
    download: 'herunterladen',
    transparent: 'transparent',
    separation: 'Separation',
    sheet: 'Druckdaten',
    groups: {
      tafeln: 'Tafeln',
      tragwerk: 'Tragwerk',
      releases: 'Bautagebuch-Stempel',
      vignetten: 'App-Vignetten',
      collateral: 'Begleitmaterial',
    } as Record<string, string>,
    formats: {
      plate: 'Tafel',
      og: 'Share-Karte',
      banner: 'Banner',
      cover: 'Cover',
      spot: 'Spot',
      release: 'Stempel',
      empty: 'Vignette',
      email: 'E-Mail-Signatur',
      social: 'Social',
      linkedin: 'LinkedIn-Banner',
      deck: 'Folie',
      postcard: 'Postkarte',
    } as Record<string, string>,
  },
}

const en: typeof de = {
  meta: {
    title: 'AI for architecture and planning firms in Austria – Piloti',
    description:
      'Piloti is an AI knowledge platform for architecture and planning firms in Austria: answers on building law, OIB guidelines and project documents, with sources.',
  },
  seo: {
    pages: {
      blog: {
        title: 'Blog: building law, planning practice and AI – Piloti',
        description:
          'The Journal for architecture and planning offices and the build log from development: Austrian building law, OIB guidelines and how Piloti is built.',
      },
      journal: {
        title: 'Journal: building law and planning practice – Piloti Blog',
        description:
          'For architecture and planning offices: Austrian building law made readable, OIB guidelines and state building codes in context, and what AI changes at work.',
      },
      bautagebuch: {
        title: 'Build log: notes from development – Piloti Blog',
        description:
          'How Piloti is built, and why: notes from developing an AI knowledge platform for building law, project documents and office knowledge, written in Vienna.',
      },
      changelog: {
        title: 'What’s new: features and improvements – Piloti',
        description:
          'What changed in Piloti: new features, improvements and fixes to the AI knowledge platform for architecture and planning firms, updated continuously.',
      },
      rechenweg: {
        title: 'The maths behind the Piloti value calculator – Piloti',
        description:
          'Every step behind the Piloti example calculation: our assumptions, your numbers, an example price, and what the calculation leaves out.',
      },
      impressum: {
        title: 'Imprint – Piloti',
        description:
          'Imprint and disclosure for the Piloti website under Austrian law (§\u00a05 ECG, §\u00a025 MedienG): who is behind Piloti, where we are based and how to reach us.',
      },
      datenschutz: {
        title: 'Privacy policy – Piloti',
        description:
          'How the Piloti website handles your data: no cookies, no tracking, which services are involved, and which providers the Piloti application relies on.',
      },
      mailInbox: {
        title: 'Project mail inbox: send files to a project by email – Piloti',
        description:
          'Every Piloti project has its own email address. Who can send, what happens to attachments, why a mail bounces, and how to switch on DKIM for your domain.',
      },
      kontakt: {
        title: 'Contact: send a planning question or request a call – Piloti',
        description:
          'Write to the founders of Piloti: a planning question from your project, a question about the pilot phase or a request for a call. We answer by email.',
      },
      warum: {
        title: 'Why Piloti: AI for architecture firms in Austria',
        description:
          'Why not just ChatGPT? Piloti connects Austrian building law, your drawings and your office knowledge into answers with sources you can check, all the way to the file.',
      },
      notFound: {
        title: 'Page not found – Piloti',
        description: 'This page does not exist or has been moved.',
      },
    },
    postTitleSuffix: ' – Piloti',
    breadcrumbHome: 'Home',
    byline: 'By',
    and: 'and',
    rssTitle: 'Piloti Blog',
    rssDescription:
      'Piloti’s Journal and build log: building law, planning practice and the development of an AI knowledge platform for architecture firms.',
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
        a: 'Piloti is an AI knowledge platform for architecture and planning firms. It answers planning questions from the building law in force and from your office and project documents, and names the sources for every answer. It also takes on work that takes longer than an answer: review reports and file notes in the project, open points and recurring checks. Piloti is a proof of concept, currently being trialled with a small number of pilot offices.',
      },
      {
        q: 'Why not just use ChatGPT?',
        a: 'ChatGPT answers questions. Piloti answers them in the context of your project: from the state building codes in RIS, the OIB guidelines, your drawings and your office’s archive, with a citation down to section, clause or page that is checked against the source text before it is shown. When a document is missing, such as the zoning plan, Piloti says so instead of answering as if it had read it.',
      },
      {
        q: 'Who is Piloti for?',
        a: 'For architecture and planning firms in Austria that spend their days checking building law, OIB guidelines, standards and project documents against each other, for example on fire safety, escape routes or energy efficiency.',
      },
      {
        q: 'Which sources does Piloti use?',
        a: 'The Austrian states’ building codes from the federal legal information system (RIS), the OIB guidelines, a register of the relevant standards, your office and project documents and, where needed, web research in which every source is linked.',
      },
      {
        q: 'How traceable are the answers?',
        a: 'With every answer Piloti shows the reasoning, the assumptions, the rule that applies and the source reference down to the section, clause or page, so you can check the answer against the original. Responsibility for the design stays with you, and Piloti is not legal advice.',
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
        a: 'Send a real planning question from a current project to {email}. We will show you how Piloti answers it. We are building Piloti with a few offices that try it on real planning questions from their daily work and tell us honestly what is missing.',
      },
    ],
  },
  skipLink: 'Skip to content',
  // Drawing-set index shown in the page margin (see SheetIndex.astro).
  sheets: {
    hero: '01 Start',
    story: '02 Problem and solution',
    nutzung: '03 Usage',
    arbeit: '04 Handing over work',
    daten: '05 Sources and data',
    wert: '06 Value',
    team: '07 Team',
    faq: '08 Questions',
    kontakt: '09 Contact',
  },
  nav: {
    ariaLabel: 'Main navigation',
    logoLabel: 'Piloti, homepage',
    signIn: 'Sign in',
    signInPending: 'Redirecting…',
    cta: 'Bring a question',
    why: 'Why Piloti',
    compare: 'Comparisons',
    langLabel: 'Choose language',
    menu: 'Menu',
    menuOpen: 'Open menu',
    menuClose: 'Close menu',
    sectionsLabel: 'On this page',
    sections: [
      { href: '#problem', label: 'Problem and solution' },
      { href: '#nutzung', label: 'Usage' },
      { href: '#arbeit', label: 'Handing over work' },
      { href: '#daten', label: 'Sources and data' },
      { href: '#wert', label: 'Value calculator' },
      { href: '#team', label: 'Team' },
      { href: '#faq', label: 'Questions' },
      { href: '#kontakt', label: 'Contact' },
    ],
    blog: 'Blog',
    changelog: 'What’s new',
  },
  hero: {
    title: 'Plan more. Search less.',
    sub: 'Building law, office and project knowledge. In one place.',
    stage: 'Proof of concept · Pilot phase with selected offices',
    ctaDemo: 'Try it with a real question',
    ctaMore: 'Learn more',
  },
  story: {
    problemA: 'Architects shape our future,',
    problemB: 'yet the knowledge it takes is scattered.',
    solution:
      'Piloti connects building law, project documents and office knowledge in one knowledge base.',
    cardTagline: 'The clause in the code, the drawing from 2019, the condition from the authority. In one answer.',
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
    title: 'The right knowledge for every planning task.',
    body: 'You design, Piloti supplies the context: the regulation that applies, the experience from your past projects and the conditions on your plot. The decision stays yours.',
    big: '≈\u202f30\u00a0s',
    sub: 'measured typical response time',
    howLead: 'How an answer comes about:',
    howLabel: 'How Piloti works',
    howHref: '/en/blog/how-piloti-works/',
  },
  arbeit: {
    title: 'Hand over work. Not just questions.',
    body: 'A reference book waits until you ask. Piloti takes on tasks: it researches drawings and regulations, files the report in the project, turns findings into open points and checks again when you want it to.',
    label: 'Fictional project · every step a shipped feature',
    boardLabel: 'A week with Piloti, fictional example',
    close: 'Deadlines, findings and approvals stay in the project, visible to the whole team. That is the difference between a tool that answers and one that works alongside you.',
    link: 'Every feature in the changelog',
    status: { ok: 'met', open: 'open' },
    steps: {
      ask: {
        when: 'Mon · You, in the chat',
        quote: '“Do the submission check for the Vienna 1030 housing scheme by Friday.”',
        note: 'One sentence is enough. It becomes a task, under your name and with your permissions.',
      },
      run: {
        when: 'Mon · Task running',
        title: 'Submission check · Housing 1030',
        line: 'Researching · 3\u00a0rounds · 9\u00a0documents',
        note: 'Reads the project’s drawings, permit and zoning plan and the regulations that apply. You keep asking in the same chat.',
      },
      report: {
        when: 'Mon · Report in the project',
        title: 'Submission review report',
        summary: '2 met · 1 open',
        rows: [
          { req: 'Escape routes', ok: true },
          { req: 'Parking spaces', ok: true },
          { req: 'Façade fire stop', ok: false },
        ],
        note: 'Verdict first, then one row per requirement, with its citation. Filed under “Reports”.',
      },
      open: {
        when: 'Tue · Open point',
        title: 'Fire stop missing in the façade section',
        action: 'Clarify',
        note: 'The finding becomes a task of its own. The project memory keeps it open until it is resolved.',
      },
      review: {
        when: 'Thu · Inbox',
        title: 'Review report for approval',
        approve: 'Approve',
        changes: 'Request changes',
        note: 'The project lead approves or sends it back, and Piloti revises it from the reason given.',
      },
      repeat: {
        when: 'From now on · Schedule',
        quote: '“Check this every Monday.”',
        note: 'The check runs again every week, and the result comes to your inbox.',
      },
    },
  },
  daten: {
    title: 'Sources you can check.',
    body: 'Responsibility for the design stays with you.',
    // The list's accessible name; the heading above says the rest.
    sourcesLabel: 'What Piloti draws on',
    cards: [
      { title: 'Regulations', body: 'State building codes, OIB guidelines, a register of standards' },
      { title: 'Your office', body: 'Plans, documents, experience from past projects' },
      { title: 'Your project', body: 'Site, plot, official requirements' },
      { title: 'Web research', body: 'Current sources, each backed by a link' },
    ],
    proof: {
      answerHeading: 'With every answer',
      answer: [
        { label: 'Reasoning', value: 'why the answer is what it is' },
        { label: 'Assumptions', value: 'what it rests on' },
        { label: 'Rules', value: 'which regulation applies' },
        { label: 'Source reference', value: 'clause, section, page' },
      ],
      dataHeading: 'With your data',
      data: [
        'We do not train models on your data.',
        'Plans and projects remain the property of your office.',
        'You download documents and answers one by one.',
        'Sign-in through WorkOS (USA). AI requests go through OpenRouter (USA) to model providers that may be based outside the EU.',
      ],
      link: 'Details in the privacy policy',
    },
  },
  roi: {
    title: 'Do the maths yourself.',
    body: 'We assume that around 30% of a planning week goes into searching, for codes, past projects and reference values, and that Piloti gives 40% of that back. Nobody has measured this yet. Put in your office and an example price and see what the assumption would be worth.',
    fields: {
      seats: 'Planners using Piloti',
      salary: 'Average gross annual salary',
      price: 'Example price per seat per month',
    },
    stepDown: 'One seat fewer',
    stepUp: 'One seat more',
    salaryNote: 'per person, including 13th and 14th salaries, excluding employer on-costs',
    claimsLabel: 'Our assumptions',
    claims: {
      week: 'Work week',
      research: 'Share spent searching',
      saved: 'Of that, Piloti gives back',
    },
    resultLabel: 'Annual value · example',
    resultNote: 'net of the example price, across your whole office, if the assumptions hold',
    metrics: {
      hours: 'Time recovered',
      payback: 'Pays for itself in',
      ratio: 'Value per euro',
    },
    footnote:
      'An example calculation from our assumptions, your numbers and an example price. Not an offer and not a promise. Every step is laid out in',
    footnoteLink: 'the full working',
    units: {
      hours: '{value}\u00a0h/year',
      hoursPlain: '{value}\u00a0h',
      perHour: '{value}/h',
      times: '×\u00a0{value}',
      perYear: '12\u00a0×\u00a0{value}',
      minus: '−{value}',
      fte: '≈\u202f{value} full-time roles',
      months: '{value}\u00a0months',
      ratio: '{value}×',
      never: '–',
      approx: '≈\u202f{value}',
      seatsSpoken: '{value} planners',
      office:
        'This working is for {seats} seats, an average gross salary of {salary} and an example price of {price} per seat per month.',
      officeOne:
        'This working is for one seat, an average gross salary of {salary} and an example price of {price} per seat per month.',
    },
  },
  rechenweg: {
    back: 'Change the numbers',
    title: 'The whole calculation, in the open.',
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
      bracket: 'Searching: 30% of the week',
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
      'These are assumptions, not measurements from customer projects. The price is an example too, not an offer. If your search time is 20%, the value per seat nearly halves.',
  },
  team: {
    title: 'Three founders, one aim: knowledge where the planning happens.',
    body: 'Architecture, software and sales at one table. We are building Piloti together with our pilot offices, on their real questions.',
    listLabel: 'The founders',
  },
  cta: {
    title: 'Bring us a real question.',
    body: 'Send us a planning question from a current project, with the documents if you like. We will show you how Piloti answers it, with sources you check against the original. If it fits, you plan with us as a pilot office: early access, a direct line to us founders and a say in what we build next.',
    primary: 'Try it with a real question',
    stepsLabel: 'What happens next',
    steps: [
      { title: 'You send a question', body: 'A real one from your project, with the location and building type. Documents if you like.' },
      { title: 'We show you the answer', body: 'In a call, with your documents and the sources Piloti draws on.' },
      { title: 'You plan with Piloti', body: 'As a pilot office, on questions from your working day, and you tell us what is missing.' },
    ],
    subjectPilot: 'A planning question for Piloti',
    bodyPilot:
      'Hello,\n\nhere is a question from one of our projects.\n\nOur question:\nState and location:\nBuilding type (e.g. housing, school, existing building):\nOffice and planners on the team:\n\n',
  },
  contact: {
    label: 'Contact form',
    name: 'Name',
    email: 'Email',
    office: 'Office or company',
    optional: 'optional',
    message: 'Your message',
    messageHint: 'A planning question from a current project, with the location and building type, or times that suit you for a call.',
    submit: 'Send message',
    sending: 'Sending …',
    privacy: 'We use what you enter to answer your enquiry. More in our {link}.',
    privacyLink: 'privacy policy',
    alternative: 'With documents, or if you prefer email: {email}',
    honeypot: 'Please leave this field empty',
    errors: {
      required: 'Please fill in this field.',
      email: 'Please enter a valid email address.',
      too_long: 'Please shorten this to {max} characters or fewer.',
    },
    status: {
      sent: 'Thank you, your message has arrived. We will answer you by email.',
      invalid: 'Please check the marked fields.',
      retry: 'Please send the message once more. What you entered is still there.',
      rateLimited: 'Several messages just came from your connection. Try again in ten minutes, or write to {email} directly.',
      failed: 'The message could not be sent just now. Please write to us directly at {email}.',
    },
    pageHeading: 'Write to us.',
    pageLede: 'A planning question, a question about the pilot phase or a request for a call: the message goes straight to us founders.',
  },
  invite: {
    blog: 'We are building Piloti with a few pilot offices. If yours should be one of them, write to us.',
    changelog: 'The pilot offices help decide what comes next on this list.',
    rechenweg: 'Nobody has measured this yet. Let us measure it in your office.',
    warum: 'The best test is a question from your current project. Send us one.',
    mailInbox: 'The drawings arrive by email; Piloti answers the questions about them. Send us one from your current project.',
  },
  chat: {
    fictional: 'Fictional example',
    question:
      'I want to open the stair core to the outside and reach the units through an insulated loggia façade. What does that mean for fire safety?',
    oibTitle: 'Sec.\u00a03.5 – Façades',
    oibSub: 'Fire spread across the exterior wall, GK\u00a04',
    boTitle: '§\u00a0106 – Escape routes',
    boSub: 'Stairwell to the outside, second escape route',
    projTag: 'Project',
    projSub: 'ETICS 14\u00a0cm EPS, loggia across 2\u00a0storeys',
    decisionIntro: 'For your ETICS (GK\u00a04) you have three options:',
    optATitle: 'Loggia in A2',
    optASub: 'remaining façade EPS ≤\u202f10\u00a0cm',
    optBTitle: 'EPS >\u202f10\u00a0cm with fire stop',
    optBSub: 'fire stop on each storey',
    optCTitle: 'Clarify with the authority',
    optCSub: 'loggia as an “open passage”',
    impl: 'Implementation – B',
    steps: [
      'Add the fire stop on each storey in the façade section',
      'Attach the OIB-RL\u00a02, Sec.\u00a03.5 verification to the submission',
      'Carry the additional €4,200 into the cost estimate',
    ],
    resume: 'Resume',
  },
  chain: {
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
  stories: {
    region: 'Decision chain, fictional example',
    leads: [
      'You ask, the way you would ask a colleague.',
      'Piloti finds the provisions that apply, in building law and in your drawings.',
      'Piloti lays out the options and explains them. You choose.',
      'Your choice becomes the next steps, right into the cost estimate.',
    ],
    frames: ['Question', 'Sources', 'Decision', 'Implementation'],
    stepOf: 'Step {n} of {total}: {name}',
    prev: 'Previous step',
    next: 'Next step',
    pause: 'Pause',
    play: 'Play',
    replay: '↻ Again',
    flipHint: 'Tap a card: excerpt',
    context: [
      ['Project', 'Housing, Vienna 1030'],
      ['Building class', 'GK\u00a04'],
      ['Asked by', 'Project lead'],
    ],
    gistLabel: 'Paraphrased, fictional',
    gists: [
      'EPS over 10\u00a0cm in GK\u00a04 only with a continuous fire stop on every storey.',
      'A stairwell led outside stays smoke-free; the loggia stays open.',
      'Section A–A: ETICS 14\u00a0cm EPS across 1st and 2nd floor, no fire stop drawn.',
    ],
    whyHint: 'Tap an option: reasoning',
    why: [
      'Not chosen: costlier material, the façade is split in two.',
      'Chosen: meets GK\u00a04, the insulation thickness stays.',
      'Not chosen: outcome open, the procedure is delayed.',
    ],
    complete: 'Complete chain',
    cost: '≈\u202f€4,200 into the cost estimate',
  },
  footer: {
    ariaLabel: 'Footer',
    tagline: 'AI for architecture and planning firms. Built in Vienna.',
    productHeading: 'Product',
    companyHeading: 'Learn more',
    legalHeading: 'Legal',
    contactHeading: 'Contact',
    contactBody: 'Questions, objections, or interested in the pilot phase?',
    usage: 'Usage',
    data: 'Sources and data',
    value: 'Value calculator',
    working: 'The maths',
    mailInbox: 'Project mail inbox',
    team: 'Team',
    why: 'Why Piloti',
    blog: 'Blog',
    changelog: 'What’s new',
    privacy: 'Privacy',
    imprint: 'Imprint',
    block: [
      { label: 'Project', value: 'Piloti' },
      { label: 'Issue', value: '' },
      { label: 'Place', value: 'Vienna' },
      { label: 'Scale', value: '1:1' },
      { label: 'Stage', value: 'Proof of concept' },
    ],
  },
  blog: {
    heading: 'From the office and from the site.',
    filterLabel: 'Posts by category',
    filterAll: 'All',
    categoryLabel: 'Category',
    entry: 'Entry',
    empty: 'No posts yet. The first article is in the works.',
    allPosts: '← All posts',
  },
  changelog: {
    heading: 'What has changed in Piloti.',
    empty: 'Nothing here yet. The first change appears the day it ships.',
    unreleased: 'Coming up',
    versionLabel: 'Version',
    olderHeading: 'Earlier changes',
    buildHeading: 'Construction log',
    weekShort: 'Week\u00a0{n}',
    monthCount: '{count} weeks',
    monthCountOne: '1 week',
  },
  notFound: {
    heading: 'This page is not in the plan.',
    body: 'The page you are looking for does not exist or has been moved.',
    home: 'Back to the homepage',
    blog: 'Read the blog',
  },
  legal: {
    emailLabel: 'Email',
    updated: 'Last updated: September 2026',
    impressum: {
      heading: 'Imprint',
      ownerHeading: 'Media owner, publisher and service provider',
      legalForm: 'civil-law partnership (GesbR) under Austrian law',
      brand: 'operating under the project name “Piloti”',
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
          id: 'kontakt',
          heading: 'Contact form and email',
          html: 'If you write to us through the contact form or at <a href="mailto:kontakt@piloti.at">kontakt@piloti.at</a>, we process what you enter (name, email address, office or company if given, and your message) to answer your enquiry. The legal basis is Art. 6(1)(b) GDPR where your enquiry concerns a contract or steps towards one, and otherwise our legitimate interest in answering enquiries (Art. 6(1)(f) GDPR). To protect against abuse, your IP address is processed when you send the form: we count submissions per address in memory for at most ten minutes. The IP address is not stored and not passed on with your message. Cloudflare, Inc. (USA) delivers the message from the form by email and forwards mail sent to kontakt@piloti.at; Cloudflare is certified under the EU-US Data Privacy Framework (Art. 45 GDPR). Both arrive in the founders’ email mailboxes; nothing of it is stored on this website. We delete your message once your enquiry is dealt with, at the latest after twelve months, unless a contract follows.',
        },
        {
          heading: 'Sign-in and the Piloti application',
          html: '“Sign in” takes you from this website to the Piloti application, which has its own privacy policy. In short: sign-in is handled by WorkOS, Inc. (USA). AI requests are routed through OpenRouter, Inc. (USA) to model providers that may be based outside the EU. Mail sent to a project’s email address is received by Cloudflare, Inc. (USA) and passed on to the application; if the application refuses such a mail, we process it only to refuse it and store none of it (legitimate interest, Art. 6(1)(f) GDPR). We do not train AI models on your data.',
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
  bildmaterial: {
    title: 'Image assets – Piloti',
    description: 'Every Piloti risograph print to download.',
    heading: 'Image assets',
    all: 'Everything as ZIP',
    zip: 'ZIP',
    download: 'download',
    transparent: 'transparent',
    separation: 'Separation',
    sheet: 'Print data',
    groups: {
      tafeln: 'Plates',
      tragwerk: 'Structure',
      releases: 'Build log stamps',
      vignetten: 'App vignettes',
      collateral: 'Collateral',
    },
    formats: {
      plate: 'Plate',
      og: 'Share card',
      banner: 'Banner',
      cover: 'Cover',
      spot: 'Spot',
      release: 'Stamp',
      empty: 'Vignette',
      email: 'Email signature',
      social: 'Social',
      linkedin: 'LinkedIn banner',
      deck: 'Slide',
      postcard: 'Postcard',
    },
  },
}

export const ui = { de, en }

export const landingScript = {
  de: {
    question: de.chat.question,
    aura: de.chain.aura,
    roi: de.roi.units,
  },
  en: {
    question: en.chat.question,
    aura: en.chain.aura,
    roi: en.roi.units,
  },
}
