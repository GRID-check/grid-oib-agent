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
    ablauf: '03 Ablauf',
    nutzung: '04 Nutzung',
    rollen: '05 Für wen',
    daten: '06 Datengrundlage',
    abdeckung: '07 Abdeckung',
    ki: '08 Daten und Transparenz',
    fragen: '09 Offene Fragen',
    kontakt: '10 Kontakt',
  },
  nav: {
    ariaLabel: 'Hauptnavigation',
    logoLabel: 'Piloti — Startseite',
    signIn: 'Anmelden',
    signInPending: 'Weiterleitung…',
    cta: 'Demo anfragen',
    langLabel: 'Sprache wählen',
    // Anchor nav in the bar's left margin — the same order as the page.
    links: {
      ablauf: 'Ablauf',
      nutzung: 'Nutzung',
      rollen: 'Für wen',
      daten: 'Datengrundlage',
    },
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
  ablauf: {
    tag: 'Ablauf',
    title: 'Von der Frage zur belegten Antwort.',
    lead: 'Vier Schritte — von dem Satz, den Sie ohnehin im Kopf haben, bis zu dem Nachweis, der in der Einreichung liegt.',
    steps: [
      {
        title: 'Frage stellen',
        body: 'Sie fragen in normaler Sprache und im Kontext Ihres Projekts — so, wie Sie es der erfahrenen Kollegin am Nebentisch zurufen würden. Kein Suchformular, keine Stichwortliste.',
      },
      {
        title: 'Quellen ziehen',
        body: 'Piloti zieht die einschlägige Landesbauordnung und OIB-Richtlinie heran, dazu Ihr Projektarchiv und die passenden Fachdaten — und prüft sie gegen die Randbedingungen Ihres Projekts.',
      },
      {
        title: 'Antwort mit Entscheidungskette',
        body: 'Sie sehen nicht nur das Ergebnis, sondern den Weg dorthin: Annahmen, Abwägung, Varianten. Jede Aussage hängt an ihrer Quelle — Paragraf, OIB-Punkt, Datenblatt oder eigenes Projekt.',
      },
      {
        title: 'In die Planung übernehmen',
        body: 'Die Kette lässt sich prüfen, im Team teilen und der Einreichung beilegen. Entschieden wird im Büro — Piloti liefert die Grundlage, auf die Sie sich dabei berufen.',
      },
    ],
  },
  nutzung: {
    tag: 'Nutzung',
    title: 'Zu jeder Planungsaufgabe das passende Wissen.',
    body: 'Sie entwerfen, Piloti liefert den Kontext: passende Projekterfahrung, einzuhaltende Rahmenbedingungen, die richtigen Materialkennwerte und Ihre Budgetziele — genau das, was Sie brauchen, um die richtigen Entscheidungen zu treffen.',
    big: 'Sekunden',
    sub: 'statt Stunden — Antwort mit Verweis auf Paragraf, Richtlinie und Herleitung.',
  },
  rollen: {
    tag: 'Für wen',
    title: 'Ein Werkzeug, vier Blickwinkel auf dasselbe Projekt.',
    lead: 'Piloti sitzt dort, wo im Büro ohnehin nachgefragt wird — und beantwortet in jeder Rolle eine andere Frage an dieselbe Wissensbasis.',
    roles: [
      {
        title: 'Entwurf',
        body: 'Früh wissen, was geht: Bebauungsbestimmungen, Abstände, Höhen und Brandschutz sind schon in der Skizze beantwortet — nicht erst in der Prüfung.',
      },
      {
        title: 'Einreichplanung',
        body: 'Jeder Nachweis mit Verweis auf Paragraf und OIB-Punkt. Die Herleitung liegt bei, bevor die Behörde danach fragt.',
      },
      {
        title: 'Projektleitung',
        body: 'Auflagen, Annahmen und getroffene Entscheidungen an einem Ort — nachvollziehbar auch dann, wenn jemand aus dem Team wechselt.',
      },
      {
        title: 'Büroleitung',
        body: 'Das Wissen aus abgeschlossenen Projekten bleibt im Büro und wird abrufbar, statt an einzelnen Personen zu hängen.',
      },
    ],
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
  abdeckung: {
    tag: 'Abdeckung',
    title: 'Welches Recht Piloti heute kennt.',
    lead: 'Konkret genug, dass Sie es nachprüfen können. Piloti arbeitet mit einem kuratierten Verzeichnis österreichischer Rechtsquellen — den Volltext holt es zum Zeitpunkt der Frage aus dem RIS, nicht aus einer Kopie bei uns.',
    groups: [
      {
        label: 'Landesrecht',
        title: 'Alle neun Bundesländer',
        body: 'Bauordnung für Wien, NÖ Bauordnung 2014, Oö. Bauordnung 1994, Steiermärkisches Baugesetz, Kärntner Bauordnung 1996, Salzburger Bautechnikgesetz 2015, Tiroler Bauordnung 2022, Vorarlberger Baugesetz, Burgenländisches Baugesetz 1997. Für Wien zusätzlich Bautechnikverordnung 2023, Garagengesetz und Kleingartengesetz sowie die Merkblätter der MA&nbsp;37 — zitiert als behördliche Praxis, nie als Norm. Welches Landesrecht gilt, entscheidet das Bundesland Ihres Projekts; die übrigen acht bleiben aus der Antwort draußen.',
      },
      {
        label: 'OIB',
        title: 'Richtlinien 1 bis 6, Ausgabe 2023',
        body: 'Samt Leitfäden, Erläuterungen und Begriffsbestimmungen. Verbindlich sind die Richtlinien nur, soweit das Landesrecht sie dazu erklärt — in Wien über die WBTV&nbsp;2023. Piloti führt diesen Zusammenhang zu jeder Richtlinie mit, statt sie wie ein Gesetz zu zitieren.',
      },
      {
        label: 'Bundesrecht',
        title: 'Was neben der Baubewilligung mitläuft',
        body: 'ASchG und AStV, Bauarbeitenkoordinationsgesetz, Ziviltechnikergesetz 2019, Wohnungsgemeinnützigkeitsgesetz, Denkmalschutzgesetz, UVP-G 2000, Wasserrechtsgesetz, Forstgesetz und Gewerbeordnung — die Materien, die ihr eigenes Verfahren mitbringen.',
      },
      {
        label: 'Aktualität',
        title: 'Was bei einer Novelle passiert',
        body: 'Das Verzeichnis hält geprüfte Verweise, der Text kommt live aus dem RIS: Eine Novelle wirkt, sobald sie dort konsolidiert ist — ohne Update auf unserer Seite. Jede Fundstelle verlinkt auf das RIS-Dokument, damit Sie die Fassung selbst ansehen.',
      },
    ],
    note: 'Nicht enthalten: ÖNORMEN im Volltext — die Richtlinien verweisen darauf, der Normtext selbst liegt bei Austrian Standards. Bebauungsplan und Widmung kommen aus Ihrem Projektakt, nicht aus dem Verzeichnis.',
  },
  ki: {
    tag: 'Daten & Transparenz',
    title:
      'Keine Blackbox. Piloti macht KI und Daten nachvollziehbar — die Verantwortung bleibt bei Ihnen.',
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
  fragen: {
    tag: 'Offene Fragen',
    title: 'Was Sie fragen würden, bevor Sie uns schreiben.',
    lead: 'Ehrlich beantwortet — auch dort, wo die Antwort heute noch „steht nicht fest“ lautet.',
    items: [
      {
        q: 'Wer haftet, wenn Piloti falsch liegt?',
        a: 'Sie — wie bei jeder Unterlage, die Sie prüfen und unterschreiben. Piloti ist kein Ziviltechniker, erstellt keinen Nachweis und ersetzt keine Prüfung; an Ihrer Verantwortung nach dem Ziviltechnikergesetz ändert es nichts. Genau deshalb ist die Entscheidungskette so gebaut, wie sie gebaut ist: Jede Aussage nennt ihre Fundstelle und verlinkt sie, damit Gegenlesen Minuten dauert statt einer Nachrecherche. Eine Antwort, die Sie nicht prüfen können, ist für uns ein Fehler im Produkt.',
      },
      {
        q: 'Was kostet Piloti?',
        a: 'Es gibt heute keine Preisliste, weil es noch kein offen buchbares Produkt gibt. Piloti ist im Frühzugang; die Konditionen für die Pilotphase besprechen wir im Erstgespräch — und nennen sie, bevor Sie uns Daten übergeben.',
      },
      {
        q: 'Wie lange dauert es, bis das etwas bringt?',
        a: 'Für das Erstgespräch brauchen Sie nichts vorzubereiten. Für eine Demo genügen die Unterlagen eines abgeschlossenen Projekts: Sie sehen an Ihren eigenen Plänen, ob die Antworten taugen, bevor Sie Ihr Archiv anfassen.',
      },
      {
        q: 'Funktioniert das auch für ein Büro mit zwölf Leuten?',
        a: 'Dafür ist es gedacht. Piloti setzt kein BIM-Modell, keine strukturierte Ablage und keine eigene IT voraus — es arbeitet mit den Plan- und PDF-Ordnern, die Sie ohnehin haben. Der Frühzugang läuft bewusst mit wenigen Büros, damit wir jedes einzeln begleiten können.',
      },
      {
        q: 'Was passiert mit unseren Plänen?',
        a: 'Sie bleiben Ihre. Cloud und KI laufen in der EU nach DSGVO, wir trainieren keine Modelle mit Ihren Daten, und Sie können den Bestand jederzeit exportieren oder löschen lassen.',
      },
      {
        q: 'Woran scheitert Piloti?',
        a: 'An allem, was nicht in den Quellen steht: an der Auslegung Ihres Referenten, an mündlichen Zusagen, an Normtexten, die wir nicht weitergeben dürfen. Piloti verkürzt die Recherche — das Gespräch mit der Behörde und die Entscheidung nimmt es Ihnen nicht ab.',
      },
    ],
  },
  cta: {
    titleHtml: 'Bringen Sie Intelligenz in jede Planungs&shy;entscheidung.',
    chips: ['Effizienz steigern', 'Planungsfehler vermeiden', 'Mehr Zeit für Kreatives'],
    demo: 'Demo anfragen',
    waitlist: 'Auf die Warteliste',
    subjectDemo: 'Demo-Anfrage',
    subjectWaitlist: 'Warteliste',
    note: 'Frühzugang: Piloti ist noch nicht offen buchbar. Schreiben Sie uns, woran Sie gerade planen — wir melden uns mit einem Termin.',
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
    optCSub: 'Loggia als „offener Durchgang“',
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
    usage: 'Nutzung',
    data: 'Datengrundlage',
    coverage: 'Abdeckung',
    faq: 'Offene Fragen',
    blog: 'Blog',
    privacy: 'Datenschutz',
    imprint: 'Impressum',
  },
  blog: {
    metaTitle: 'Blog — Piloti',
    metaDescription:
      'Einblicke in KI-gestützte Planung, Baurecht und die Arbeit von Architektur- und Planungsbüros.',
    tag: 'Blog',
    heading: 'Wissen, das weiterbringt.',
    intro: 'Einblicke in KI-gestützte Planung, Baurecht und den Büroalltag — vom Piloti-Team.',
    empty: 'Noch keine Beiträge — der erste Artikel ist in Arbeit.',
    readMore: 'Weiterlesen →',
    allPosts: '← Alle Beiträge',
  },
  notFound: {
    metaTitle: 'Seite nicht gefunden — Piloti',
    metaDescription: 'Diese Seite existiert nicht.',
    heading: 'Diese Seite liegt nicht im Plan.',
    body: 'Die gesuchte Seite existiert nicht oder wurde verschoben.',
    home: 'Zur Startseite',
  },
  legal: {
    tag: 'Rechtliches',
    emailLabel: 'E-Mail',
    impressum: {
      metaTitle: 'Impressum — Piloti',
      metaDescription: 'Impressum und Medieninhaber der Piloti-Website.',
      heading: 'Impressum',
      ownerHeading: 'Medieninhaber und Herausgeber',
      purposeHeading: 'Unternehmensgegenstand',
      purpose: 'Softwareentwicklung und Bereitstellung von KI-gestützten Planungswerkzeugen.',
      registerHeading: 'Angaben gemäß § 5 ECG und § 25 MedienG',
      registerNumberLabel: 'Firmenbuchnummer',
      registerCourtLabel: 'Firmenbuchgericht',
      uidLabel: 'UID-Nummer',
      registerNote: 'Zuständige Kammer und Behörde — wird vor dem Livegang ergänzt.',
      liabilityHeading: 'Haftung für Inhalte',
      liability:
        'Die Inhalte dieser Website werden mit Sorgfalt erstellt. Für Richtigkeit, Vollständigkeit und Aktualität wird keine Gewähr übernommen. Inhalte zu baurechtlichen Themen stellen keine Rechtsberatung dar.',
    },
    datenschutz: {
      metaTitle: 'Datenschutz — Piloti',
      metaDescription: 'Datenschutzerklärung der Piloti-Website.',
      heading: 'Datenschutzerklärung',
      controllerHeading: 'Verantwortlicher',
      siteHeading: 'Diese Website',
      siteHtml:
        'Diese Website setzt <strong>keine Cookies</strong> und verwendet <strong>keine Tracking- oder Analysewerkzeuge</strong>. Es werden keine personenbezogenen Daten zu statistischen oder Marketingzwecken verarbeitet.',
      logsHeading: 'Server-Logdateien',
      logsHtml:
        'Beim Aufruf der Website verarbeitet der Hosting-Betreiber technisch notwendige Verbindungsdaten (z.&nbsp;B. IP-Adresse, Zeitpunkt, abgerufene Seite) in Server-Logs, um den Betrieb und die Sicherheit der Website zu gewährleisten (Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;f DSGVO). Diese Daten werden nicht mit anderen Datenquellen zusammengeführt.',
      contactHeading: 'Kontaktaufnahme',
      contactHtml:
        'Bei Kontaktaufnahme per E-Mail verarbeiten wir die übermittelten Daten (Name, E-Mail-Adresse, Inhalt der Anfrage) zur Bearbeitung der Anfrage (Art.&nbsp;6 Abs.&nbsp;1 lit.&nbsp;b DSGVO). Die Daten werden gelöscht, sobald sie für den Zweck nicht mehr erforderlich sind.',
      rightsHeading: 'Ihre Rechte',
      rightsHtml:
        'Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch. Beschwerderecht bei der österreichischen Datenschutzbehörde (dsb.gv.at).',
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
    ablauf: '03 How it works',
    nutzung: '04 Usage',
    rollen: '05 Who it’s for',
    daten: '06 Data foundation',
    abdeckung: '07 Coverage',
    ki: '08 Data and transparency',
    fragen: '09 Open questions',
    kontakt: '10 Contact',
  },
  nav: {
    ariaLabel: 'Main navigation',
    logoLabel: 'Piloti — homepage',
    signIn: 'Sign in',
    signInPending: 'Redirecting…',
    cta: 'Request a demo',
    langLabel: 'Choose language',
    // Anchor nav in the bar's left margin — the same order as the page.
    links: {
      ablauf: 'How it works',
      nutzung: 'Usage',
      rollen: 'Who it’s for',
      daten: 'Data foundation',
    },
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
  ablauf: {
    tag: 'How it works',
    title: 'From the question to an answer you can cite.',
    lead: 'Four steps — from the sentence already in your head to the verification that ends up in the submission.',
    steps: [
      {
        title: 'Ask the question',
        body: 'You ask in plain language and in the context of your project — the way you would ask the experienced colleague at the next desk. No search form, no list of keywords.',
      },
      {
        title: 'Sources are pulled',
        body: 'Piloti brings in the relevant state building code and OIB guideline, along with your project archive and the matching technical data — and checks them against the constraints of your project.',
      },
      {
        title: 'An answer with its decision chain',
        body: 'You see not just the result but the way there: assumptions, trade-offs, alternatives. Every statement hangs on its source — clause, OIB section, data sheet or one of your own projects.',
      },
      {
        title: 'Carry it into the plan',
        body: 'The chain can be reviewed, shared with the team and attached to the submission. The decision is made in the office — Piloti supplies the ground you stand on.',
      },
    ],
  },
  nutzung: {
    tag: 'Usage',
    title: 'The right knowledge for every planning task.',
    body: 'You design, Piloti delivers the context: relevant project experience, the constraints to meet, the right material values and your budget targets — exactly what you need to make the right decisions.',
    big: 'Seconds',
    sub: 'instead of hours — an answer with references to the clause, the guideline and its derivation.',
  },
  rollen: {
    tag: 'Who it’s for',
    title: 'One tool, four views of the same project.',
    lead: 'Piloti sits where the questions get asked in the office anyway — answering a different question from the same knowledge base in every role.',
    roles: [
      {
        title: 'Design',
        body: 'Know early what is possible: zoning rules, setbacks, heights and fire safety are answered while it is still a sketch — not once it is under review.',
      },
      {
        title: 'Permit submission',
        body: 'Every verification with a reference to the clause and the OIB section. The derivation is attached before the authority asks for it.',
      },
      {
        title: 'Project management',
        body: 'Requirements, assumptions and the decisions already taken in one place — still traceable when someone leaves the team.',
      },
      {
        title: 'Practice leadership',
        body: 'The knowledge from finished projects stays in the office and stays retrievable, instead of living with individual people.',
      },
    ],
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
  abdeckung: {
    tag: 'Coverage',
    title: 'The law Piloti knows today.',
    lead: 'Specific enough for you to check it. Piloti works from a curated catalogue of Austrian legal sources — the full text is fetched from the RIS at the moment you ask, not from a copy held here.',
    groups: [
      {
        label: 'State law',
        title: 'All nine Bundesländer',
        body: 'Bauordnung für Wien, NÖ Bauordnung 2014, Oö. Bauordnung 1994, Steiermärkisches Baugesetz, Kärntner Bauordnung 1996, Salzburger Bautechnikgesetz 2015, Tiroler Bauordnung 2022, Vorarlberger Baugesetz, Burgenländisches Baugesetz 1997. For Vienna also the Bautechnikverordnung 2023, the Garagengesetz and the Kleingartengesetz, plus the MA&nbsp;37 guidance notes — cited as authority practice, never as law. Which state law applies is decided by your project’s Bundesland; the other eight stay out of the answer.',
      },
      {
        label: 'OIB',
        title: 'Guidelines 1 to 6, 2023 edition',
        body: 'Including the Leitfäden, Erläuterungen and Begriffsbestimmungen. The guidelines are binding only where state law declares them so — in Vienna through the WBTV&nbsp;2023. Piloti carries that connection alongside every guideline instead of citing it as if it were the statute.',
      },
      {
        label: 'Federal law',
        title: 'What runs alongside the permit',
        body: 'ASchG and AStV, Bauarbeitenkoordinationsgesetz, Ziviltechnikergesetz 2019, Wohnungsgemeinnützigkeitsgesetz, Denkmalschutzgesetz, UVP-G 2000, Wasserrechtsgesetz, Forstgesetz and Gewerbeordnung — the matters that bring their own procedure.',
      },
      {
        label: 'Currency',
        title: 'What happens at an amendment',
        body: 'The catalogue holds verified pointers, the text comes live from the RIS: an amendment takes effect as soon as it is consolidated there — with no update on our side. Every citation links to the RIS document so you can read the version yourself.',
      },
    ],
    note: 'Not included: ÖNORM full texts — the guidelines refer to them, but the standard itself stays with Austrian Standards. Zoning plan and land-use designation come from your own project file, not from the catalogue.',
  },
  ki: {
    tag: 'Data & transparency',
    title: 'No black box. Piloti makes AI and data traceable — responsibility stays with you.',
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
  fragen: {
    tag: 'Open questions',
    title: 'What you would ask before writing to us.',
    lead: 'Answered honestly — including where the answer today is still “not settled”.',
    items: [
      {
        q: 'Who is liable when Piloti is wrong?',
        a: 'You are — as with every document you check and sign. Piloti is not a chartered engineer, produces no formal verification and replaces no review; nothing about your responsibility under the Ziviltechnikergesetz changes. That is precisely why the decision chain is built the way it is: every statement names its source and links to it, so checking takes minutes rather than a fresh search. An answer you cannot verify is, to us, a defect in the product.',
      },
      {
        q: 'What does Piloti cost?',
        a: 'There is no price list today, because there is no openly bookable product yet. Piloti is in early access; we discuss the terms for the pilot in the first conversation — and name them before you hand over any data.',
      },
      {
        q: 'How long until it is useful?',
        a: 'You need to prepare nothing for the first conversation. For a demo the documents of one finished project are enough: you see on your own drawings whether the answers hold up, before you touch your archive.',
      },
      {
        q: 'Does this work for an office of twelve?',
        a: 'That is who it is for. Piloti assumes no BIM model, no structured filing and no IT department — it works with the drawing and PDF folders you already have. Early access runs deliberately with a small number of offices, so we can accompany each one individually.',
      },
      {
        q: 'What happens to our drawings?',
        a: 'They stay yours. Cloud and AI run in the EU under the GDPR, we do not train models on your data, and you can export or have the whole set deleted at any time.',
      },
      {
        q: 'Where does Piloti fail?',
        a: 'At everything that is not in the sources: your case officer’s reading, verbal assurances, standards we are not allowed to pass on. Piloti shortens the research — it does not take the conversation with the authority, or the decision, off your desk.',
      },
    ],
  },
  cta: {
    titleHtml: 'Bring intelligence to every planning decision.',
    chips: ['Boost efficiency', 'Avoid planning errors', 'More time for creative work'],
    demo: 'Request a demo',
    waitlist: 'Join the waitlist',
    subjectDemo: 'Demo request',
    subjectWaitlist: 'Waitlist',
    note: 'Early access: Piloti is not openly bookable yet. Tell us what you are working on — we will come back with a date.',
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
    optCSub: 'loggia as an “open passage”',
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
    usage: 'Usage',
    data: 'Data foundation',
    coverage: 'Coverage',
    faq: 'Open questions',
    blog: 'Blog',
    privacy: 'Privacy',
    imprint: 'Imprint',
  },
  blog: {
    metaTitle: 'Blog — Piloti',
    metaDescription:
      'Insights into AI-supported planning, building law and the work of architecture and planning firms.',
    tag: 'Blog',
    heading: 'Knowledge that moves you forward.',
    intro: 'Insights into AI-supported planning, building law and everyday office life — from the Piloti team.',
    empty: 'No posts yet — the first article is in the works.',
    readMore: 'Read on →',
    allPosts: '← All posts',
  },
  notFound: {
    metaTitle: 'Page not found — Piloti',
    metaDescription: 'This page does not exist.',
    heading: 'This page is not in the plan.',
    body: 'The page you are looking for does not exist or has been moved.',
    home: 'Back to the homepage',
  },
  legal: {
    tag: 'Legal',
    emailLabel: 'Email',
    impressum: {
      metaTitle: 'Imprint — Piloti',
      metaDescription: 'Imprint and media owner of the Piloti website.',
      heading: 'Imprint',
      ownerHeading: 'Media owner and publisher',
      purposeHeading: 'Business purpose',
      purpose: 'Software development and provision of AI-supported planning tools.',
      registerHeading: 'Information pursuant to § 5 ECG and § 25 MedienG',
      registerNumberLabel: 'Commercial register no.',
      registerCourtLabel: 'Register court',
      uidLabel: 'VAT ID',
      registerNote: 'Competent chamber and authority — to be completed before launch.',
      liabilityHeading: 'Liability for content',
      liability:
        'The content of this website is created with care. No guarantee is given for accuracy, completeness or currency. Content on building-law topics does not constitute legal advice.',
    },
    datenschutz: {
      metaTitle: 'Privacy — Piloti',
      metaDescription: 'Privacy policy of the Piloti website.',
      heading: 'Privacy policy',
      controllerHeading: 'Controller',
      siteHeading: 'This website',
      siteHtml:
        'This website sets <strong>no cookies</strong> and uses <strong>no tracking or analytics tools</strong>. No personal data is processed for statistical or marketing purposes.',
      logsHeading: 'Server log files',
      logsHtml:
        'When you visit the website, the hosting provider processes technically necessary connection data (e.g. IP address, time, page requested) in server logs to ensure the operation and security of the website (Art. 6(1)(f) GDPR). This data is not merged with other data sources.',
      contactHeading: 'Contacting us',
      contactHtml:
        'If you contact us by email, we process the data you provide (name, email address, content of your enquiry) in order to handle it (Art. 6(1)(b) GDPR). The data is deleted as soon as it is no longer required for this purpose.',
      rightsHeading: 'Your rights',
      rightsHtml:
        'You have the right of access, rectification, erasure, restriction of processing, data portability and objection. You may lodge a complaint with the Austrian Data Protection Authority (dsb.gv.at).',
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
  },
  en: {
    question: en.chat.question,
    typing: en.chain.typing,
    beats: en.chain.beats,
    aura: en.chain.aura,
  },
}
