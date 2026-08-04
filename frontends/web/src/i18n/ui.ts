export const languages = {
  de: 'Deutsch',
  en: 'English',
} as const

export type Locale = keyof typeof languages

export const defaultLang: Locale = 'de'
export const showDefaultLang = false

// One document, not ten. Every claim on this site has exactly one home:
//   • which law is covered            → `abdeckung` (named, checkable)
//   • how an answer is assembled      → `ablauf` (the four steps)
//   • what an answer looks like       → `nutzung` (the worked example)
//   • which four source kinds feed it → `daten`
//   • what the model does / does not  → `ki`
//   • liability, price, data, limits  → `fragen`
// Sections that need a neighbour's claim reference it in one clause instead of
// re-arguing it — the corpus used to say "Landesbauordnungen und OIB-Richtlinien"
// six times and "traceable to the source" seven.
const de = {
  meta: {
    title: 'Piloti — KI für Baurecht und Bürowissen in Architekturbüros',
    // A description is a search result, not a tagline: it has ~155 characters
    // to say what the tool does and what makes the answer worth trusting.
    description:
      'Piloti verknüpft Ihr Projektarchiv mit dem österreichischen Baurecht: Landesbauordnungen, OIB-Richtlinien, Materialdaten. Jede Aussage mit Fundstelle.',
  },
  skipLink: 'Zum Inhalt springen',
  // Drawing-set index shown in the page margin (see SheetIndex.astro).
  sheets: {
    hero: '01 Start',
    story: '02 Problem und Lösung',
    ablauf: '03 Ablauf',
    nutzung: '04 Beispiel',
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
      nutzung: 'Beispiel',
      rollen: 'Für wen',
      daten: 'Datengrundlage',
      abdeckung: 'Abdeckung',
      fragen: 'Fragen',
    },
  },
  hero: {
    title: 'Planen. Statt suchen.',
    sub: 'Antworten aus Baurecht, Projektarchiv und Fachdaten. Mit Fundstelle.',
    ctaDemo: 'Demo anfragen',
    ctaMore: 'Mehr erfahren',
  },
  story: {
    problemA: 'Das Wissen für ein Projekt ist vollständig vorhanden.',
    problemB: 'Nur nicht an einer Stelle abrufbar.',
    solution:
      'Piloti legt es zusammen: Projektakt, Baurecht, Fachdaten, Budget — eine Wissensbasis, die auf ganze Sätze antwortet.',
    cardTagline: 'Alles, was das Büro weiß. Und alles, was gilt.',
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
    // Labels on the drifting fragments. Proper references (§ 106 BO Wien,
    // OIB-RL 6, λ-Werte) stay in the component — they read the same in both
    // locales — but anything that is ordinary language belongs here.
    docs: {
      permit: 'Bauansuchen.pdf',
      detail: 'Sockelanschluss',
      structural: 'Statik_Nachweis',
    },
  },
  ablauf: {
    tag: 'Ablauf',
    title: 'Von der Frage zur belegten Antwort.',
    lead: 'Vier Schritte. Vom Satz, den Sie ohnehin im Kopf haben, bis zur Beilage in der Einreichung.',
    steps: [
      {
        title: 'Fragen',
        body: 'So, wie Sie es der erfahrenen Kollegin am Nebentisch schildern würden. Ganze Sätze, Ihr Projekt als Kontext. Kein Suchformular, keine Stichwortliste, kein Filterbaum.',
      },
      {
        title: 'Quellen holen',
        body: 'Zur Laufzeit, nicht aus dem Gedächtnis des Modells. Baurecht, Ihr Archiv, Fachdaten — gefiltert auf das, was für Bundesland, Widmung und Gebäudeklasse Ihres Projekts überhaupt gilt.',
      },
      {
        title: 'Entscheidungskette lesen',
        body: 'Sie sehen nicht nur das Ergebnis, sondern den Weg: Annahmen, Abwägung, verworfene Varianten. Jeder Satz hängt an seiner Fundstelle — Paragraf, OIB-Punkt, Datenblatt oder eigenes Projekt.',
      },
      {
        title: 'Übernehmen',
        body: 'Die Kette lässt sich prüfen, im Team teilen und der Einreichung beilegen. Unterschrieben wird im Büro — Piloti liefert die Grundlage, auf die Sie sich dabei berufen.',
      },
    ],
  },
  nutzung: {
    tag: 'Beispiel',
    title: 'Eine typische Frage, einmal durchgespielt.',
    body: 'Brandschutz an einer gedämmten Loggia-Fassade: welche Quellen hereinkommen, wo sie einander widersprechen, welche drei Wege bleiben und was davon in der Kostenschätzung landet. Das Beispiel ist erfunden, der Ablauf nicht.',
    big: 'Sekunden',
    sub: 'statt Stunden. Recherche, die sonst über RIS, Archiv und Telefonat läuft, in einem Durchgang.',
  },
  rollen: {
    tag: 'Für wen',
    title: 'Vier Rollen, vier Fragen, eine Wissensbasis.',
    lead: 'Hinter jeder Rolle steht dieselbe Frage: Was gilt hier, und worauf können wir uns dabei berufen? Jede Rolle braucht davon einen anderen Ausschnitt.',
    roles: [
      {
        title: 'Entwurf',
        body: 'Früh wissen, was überhaupt geht: Bebauungsbestimmungen, Abstände, Höhen, Brandschutz — beantwortet, solange es noch eine Skizze ist und nicht schon ein Plansatz.',
      },
      {
        title: 'Einreichplanung',
        body: 'Die Herleitung liegt bei, bevor die Behörde danach fragt. Und niemand muss drei Wochen später rekonstruieren, warum genau so gerechnet wurde.',
      },
      {
        title: 'Projektleitung',
        body: 'Auflagen, Annahmen und getroffene Entscheidungen an einem Ort — nachvollziehbar auch dann, wenn die Person, die sie getroffen hat, nicht mehr im Büro ist.',
      },
      {
        title: 'Büroleitung',
        body: 'Was das Büro über die Jahre gelernt hat, liegt im Archiv und in einzelnen Köpfen. Piloti macht den Teil im Archiv abfragbar.',
      },
    ],
  },
  daten: {
    tag: 'Datengrundlage',
    title: 'Vier Quellen. Drei davon gehören Ihnen.',
    body: 'Das Baurecht ist öffentlich, den Rest bringen Sie mit: Pläne aus abgeschlossenen Projekten, den Akt zum laufenden, die Kennwerte, mit denen Sie rechnen. Piloti hält die vier zusammen, damit eine Antwort aus allen vieren kommt und nicht nur aus dem Gesetz.',
    cards: [
      { title: 'Regelwerke', body: 'Landesbauordnungen, OIB-Richtlinien, Bundesmaterien' },
      { title: 'Ihr Büro', body: 'Pläne, Details und Nachweise aus abgeschlossenen Projekten' },
      { title: 'Ihr Projekt', body: 'Akt, Grundstück, Widmung, Auflagen' },
      { title: 'Fachdaten', body: 'Materialkennwerte, U-Werte, CO₂-Bilanzen' },
    ],
  },
  // Sober by design: this is the section a sceptical Ziviltechniker reads with a
  // pencil in hand. No wit, no hedging — names, editions and what is missing.
  abdeckung: {
    tag: 'Abdeckung',
    title: 'Welches Recht Piloti heute kennt.',
    lead: 'Konkret genug, dass Sie es nachprüfen können. Piloti arbeitet mit einem kuratierten Verzeichnis österreichischer Rechtsquellen; den Volltext holt es zum Zeitpunkt der Frage aus dem RIS, nicht aus einer Kopie bei uns.',
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
    title: 'Wie die Antwort entsteht — und was dabei mit Ihren Daten geschieht.',
    cards: [
      {
        title: 'Antwort aus Quellen, nicht aus dem Gedächtnis',
        body: 'Piloti holt die Quellen zur Laufzeit und formuliert daraus. Die Fachleistung steckt nicht im Sprachmodell, sondern in der Entscheidung, welche Quelle für Bauteil, Gebäudeklasse und Bundesland überhaupt einschlägig ist.',
      },
      {
        title: 'Kein Beleg, keine Aussage',
        body: 'Wo keine Fundstelle steht, steht auch keine Behauptung. Was sich nicht belegen lässt, weist Piloti als offene Frage aus statt als Ergebnis.',
      },
      {
        // Load-bearing and literal. This is the paragraph a Datenschutz-
        // beauftragte:r reads; it says only what we can stand behind.
        title: 'Ihre Daten, Ihre Kontrolle',
        body: 'Pläne und Projekte bleiben Eigentum Ihres Büros. Wir trainieren keine Modelle mit Ihren Daten. Cloud und KI laufen in der EU nach DSGVO, Export und Löschung sind jederzeit möglich.',
      },
    ],
  },
  fragen: {
    tag: 'Offene Fragen',
    title: 'Was Sie fragen würden, bevor Sie uns schreiben.',
    lead: 'Auch die unangenehmen. Und auch dort, wo die Antwort heute noch „steht nicht fest“ lautet.',
    items: [
      {
        // Precise and literal on purpose — the one answer on the page where a
        // joke would cost the reader.
        q: 'Wer haftet, wenn Piloti falsch liegt?',
        a: 'Sie — wie bei jeder Unterlage, die Sie prüfen und unterschreiben. Piloti ist kein Ziviltechniker, erstellt keinen Nachweis und ersetzt keine Prüfung; an Ihrer Verantwortung nach dem Ziviltechnikergesetz ändert es nichts. Genau deshalb ist die Entscheidungskette so gebaut, wie sie gebaut ist: Jede Aussage nennt ihre Fundstelle und verlinkt sie, damit Gegenlesen Minuten dauert statt einer zweiten Recherche. Eine Antwort, die Sie nicht prüfen können, ist für uns ein Fehler im Produkt.',
      },
      {
        q: 'Was kostet Piloti?',
        a: 'Es gibt keine Preisliste, weil es noch nichts zu buchen gibt. Piloti ist im Frühzugang; die Konditionen für die Pilotphase besprechen wir im Erstgespräch — und nennen sie, bevor Sie uns Daten übergeben.',
      },
      {
        q: 'Wie lange dauert es, bis das etwas bringt?',
        a: 'Fürs Erstgespräch brauchen Sie nichts vorzubereiten. Für eine Demo genügen die Unterlagen eines abgeschlossenen Projekts: Sie sehen an Ihren eigenen Plänen, ob die Antworten taugen, bevor Sie Ihr Archiv anfassen.',
      },
      {
        q: 'Funktioniert das auch für ein Büro mit zwölf Leuten?',
        a: 'Dafür ist es gebaut. Kein BIM-Modell, keine strukturierte Ablage, keine eigene IT — Piloti arbeitet mit den Plan- und PDF-Ordnern, die Sie ohnehin haben, in der Struktur, in der sie gewachsen sind. Der Frühzugang läuft bewusst mit wenigen Büros, damit wir jedes einzeln begleiten können.',
      },
      {
        q: 'Was passiert mit unseren Plänen?',
        a: 'Sie bleiben Ihre. Piloti liest sie, um Ihre Fragen zu beantworten — nicht, um daraus Modelle zu machen. Verarbeitet wird in der EU, nach DSGVO. Wenn Sie aufhören, nehmen Sie den Bestand mit oder lassen ihn löschen; was das im Detail heißt, steht schriftlich fest, bevor Sie die erste Datei hochladen.',
      },
      {
        q: 'Woran scheitert Piloti?',
        a: 'An allem, was nicht in den Quellen steht: an der Auslegung Ihres Referenten, an der mündlichen Zusage aus der Bauverhandlung, an Normtexten, die wir nicht weitergeben dürfen. Piloti verkürzt die Recherche. Den Termin bei der Behörde nimmt es Ihnen nicht ab.',
      },
    ],
  },
  cta: {
    titleHtml: 'Zeigen Sie uns ein Projekt. Wir zeigen Ihnen die Kette.',
    chips: ['Erstgespräch ohne Vorbereitung', 'Demo am eigenen Projekt', 'Frühzugang, wenige Büros'],
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
    // The animated diagram is the richest content on the page and is drawn in
    // absolutely positioned boxes a screen reader cannot make sense of, so it
    // is `aria-hidden` and these labels caption the same material as prose.
    a11y: {
      label: 'Fiktives Beispiel: Ablauf einer Antwort mit Entscheidungskette',
      questionLabel: 'Frage',
      sourcesLabel: 'Herangezogene Quellen',
      optionsLabel: 'Entscheidung — drei Wege',
      stepsLabel: 'Umsetzung — Weg B, drei Schritte',
    },
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
    usage: 'Beispiel',
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
      'Notizen zu Baurecht, Planungsalltag und der Arbeit an Piloti — vom Team dahinter.',
    tag: 'Blog',
    heading: 'Notizen aus dem Akt.',
    intro: 'Baurecht, Planungsalltag und die Arbeit an Piloti. Vom Team dahinter.',
    empty: 'Noch nichts veröffentlicht. Der erste Beitrag liegt im Entwurf.',
    readMore: 'Weiterlesen →',
    allPosts: '← Alle Beiträge',
  },
  notFound: {
    metaTitle: 'Seite nicht gefunden — Piloti',
    metaDescription: 'Diese Seite existiert nicht.',
    heading: 'Dieses Blatt liegt nicht im Plan.',
    body: 'Die gesuchte Seite existiert nicht, wurde verschoben oder umbenannt.',
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

// Not a translation of the German — the same register written natively. Austrian
// terms of art (Einreichung, Bauverhandlung, Akt) carry no English equivalent
// that a planner would recognise, so the English states the thing plainly
// instead of transliterating it. Same voice on both sides: senior, concrete,
// short declaratives, no adjectives doing a noun's job.
const en: typeof de = {
  meta: {
    title: 'Piloti — AI for Austrian building law and office knowledge',
    description:
      'Piloti connects your project archive with Austrian building law: state building codes, OIB guidelines, material data. Every statement cites its source.',
  },
  skipLink: 'Skip to content',
  // Drawing-set index shown in the page margin (see SheetIndex.astro).
  sheets: {
    hero: '01 Start',
    story: '02 Problem and solution',
    ablauf: '03 How it works',
    nutzung: '04 Example',
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
      nutzung: 'Example',
      rollen: 'Who it’s for',
      daten: 'Data foundation',
      abdeckung: 'Coverage',
      // Shorter than the section heading on purpose: "Open questions" is 100 px
      // of bar and the English set is already the wider of the two.
      fragen: 'FAQ',
    },
  },
  hero: {
    title: 'Plan. Instead of searching.',
    sub: 'Answers from building law, your archive and technical data. Source attached.',
    ctaDemo: 'Request a demo',
    ctaMore: 'Learn more',
  },
  story: {
    problemA: 'Everything a project needs to know already exists.',
    problemB: 'Just nowhere you can query it in one go.',
    solution:
      'Piloti puts it back together: project file, building law, technical data, budget — one knowledge base that answers in full sentences.',
    cardTagline: 'Everything the office knows. And everything that applies.',
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
    docs: {
      permit: 'Permit_app.pdf',
      detail: 'Base detail',
      structural: 'Structural_cert',
    },
  },
  ablauf: {
    tag: 'How it works',
    title: 'From the question to an answer you can cite.',
    lead: 'Four steps. From the sentence already in your head to the attachment in the submission.',
    steps: [
      {
        title: 'Ask',
        body: 'The way you would describe it to the experienced colleague at the next desk. Full sentences, your project as context. No search form, no keyword list, no filter tree.',
      },
      {
        title: 'Pull the sources',
        body: 'At query time, not from the model’s memory. Building law, your archive, technical data — narrowed to what actually applies given your project’s Bundesland, land-use designation and building class.',
      },
      {
        title: 'Read the chain',
        body: 'You see the route, not only the result: assumptions, trade-offs, the options that were dropped. Every sentence hangs on its source — clause, OIB section, data sheet or one of your own projects.',
      },
      {
        title: 'Take it into the plan',
        body: 'The chain can be reviewed, shared with the team and attached to the submission. The signature happens in the office — Piloti supplies the ground you stand on.',
      },
    ],
  },
  nutzung: {
    tag: 'Example',
    title: 'A typical question, played through.',
    body: 'Fire protection on an insulated loggia façade: which sources come in, where they contradict each other, which three routes are left, and what of it ends up in the cost estimate. The example is invented, the procedure is not.',
    big: 'Seconds',
    sub: 'instead of hours. Research that normally runs across a legal database, the archive and a phone call, in a single pass.',
  },
  rollen: {
    tag: 'Who it’s for',
    title: 'Four roles, four questions, one knowledge base.',
    lead: 'Behind every role sits the same question: what applies here, and what can we cite for it. Each role needs a different part of the answer.',
    roles: [
      {
        title: 'Design',
        body: 'Know early what is even possible: zoning rules, setbacks, heights, fire safety — answered while it is still a sketch and not yet a drawing set.',
      },
      {
        title: 'Permit submission',
        body: 'The derivation is attached before the authority asks for it. And nobody has to reconstruct three weeks later why it was calculated that way.',
      },
      {
        title: 'Project management',
        body: 'Requirements, assumptions and the decisions already taken in one place — still traceable when the person who took them is no longer in the office.',
      },
      {
        title: 'Practice leadership',
        body: 'What the office has learned over the years sits in the archive and in individual heads. Piloti makes the archive part searchable.',
      },
    ],
  },
  daten: {
    tag: 'Data foundation',
    title: 'Four sources. Three of them are yours.',
    body: 'Building law is public; you bring the rest — drawings from finished projects, the file on the running one, the values you calculate with. Piloti holds the four together so an answer comes out of all of them and not just out of the statute.',
    cards: [
      { title: 'Regulations', body: 'State building codes, OIB guidelines, federal matters' },
      { title: 'Your office', body: 'Drawings, details and verifications from finished projects' },
      { title: 'Your project', body: 'Project file, plot, land-use designation, requirements' },
      { title: 'Technical data', body: 'Material values, U-values, CO₂ balances' },
    ],
  },
  abdeckung: {
    tag: 'Coverage',
    title: 'The law Piloti knows today.',
    lead: 'Specific enough for you to check it. Piloti works from a curated catalogue of Austrian legal sources; the full text is fetched from the RIS at the moment you ask, not from a copy held here.',
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
    title: 'How the answer is built — and what happens to your data along the way.',
    cards: [
      {
        title: 'Answers from sources, not from memory',
        body: 'Piloti fetches the sources at query time and writes from them. The expertise is not in the language model; it is in deciding which source is actually relevant for this component, this building class and this Bundesland.',
      },
      {
        title: 'No source, no claim',
        body: 'Where there is no citation there is no assertion. What cannot be backed, Piloti marks as an open question rather than presenting it as a result.',
      },
      {
        title: 'Your data, your control',
        body: 'Drawings and projects remain the property of your office. We do not train models on your data. Cloud and AI run in the EU under the GDPR; export and deletion are possible at any time.',
      },
    ],
  },
  fragen: {
    tag: 'Open questions',
    title: 'What you would ask before writing to us.',
    lead: 'Including the uncomfortable ones, and the places where the answer today is still “not settled”.',
    items: [
      {
        q: 'Who is liable when Piloti is wrong?',
        a: 'You are — as with every document you check and sign. Piloti is not a chartered engineer, produces no formal verification and replaces no review; nothing about your responsibility under the Ziviltechnikergesetz changes. That is precisely why the decision chain is built the way it is: every statement names its source and links to it, so checking takes minutes and not a second round of research. An answer you cannot verify is, to us, a defect in the product.',
      },
      {
        q: 'What does Piloti cost?',
        a: 'There is no price list, because there is nothing to book yet. Piloti is in early access; we discuss the terms for the pilot in the first conversation — and name them before you hand over any data.',
      },
      {
        q: 'How long until it is useful?',
        a: 'You need to prepare nothing for the first conversation. For a demo the documents of one finished project are enough: you see on your own drawings whether the answers hold up, before you touch your archive.',
      },
      {
        q: 'Does this work for an office of twelve?',
        a: 'That is what it is built for. No BIM model, no structured filing, no IT department — Piloti works with the drawing and PDF folders you already have, in the structure they grew into. Early access runs deliberately with a small number of offices, so we can accompany each one individually.',
      },
      {
        q: 'What happens to our drawings?',
        a: 'They stay yours. Piloti reads them to answer your questions — not to make models out of them. Processing happens in the EU, under the GDPR. If you stop, you take the whole set with you or have it deleted; what that means in detail is in writing before you upload the first file.',
      },
      {
        q: 'Where does Piloti fail?',
        a: 'At everything that is not in the sources: your case officer’s reading of a clause, the verbal assurance given at the site hearing, standards we are not allowed to pass on. Piloti shortens the research. It does not take the appointment with the authority off your desk.',
      },
    ],
  },
  cta: {
    titleHtml: 'Show us one project. We will show you the chain.',
    chips: ['First call, no preparation', 'Demo on your own project', 'Early access, few offices'],
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
    a11y: {
      label: 'Fictional example: how an answer and its decision chain come together',
      questionLabel: 'Question',
      sourcesLabel: 'Sources drawn on',
      optionsLabel: 'Decision — three options',
      stepsLabel: 'Implementation — option B, three steps',
    },
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
    usage: 'Example',
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
      'Notes on building law, the working day of a planning office, and the work on Piloti.',
    tag: 'Blog',
    heading: 'Notes from the file.',
    intro: 'Building law, the working day of a planning office, and the work on Piloti. From the team behind it.',
    empty: 'Nothing published yet. The first piece is still a draft.',
    readMore: 'Read on →',
    allPosts: '← All posts',
  },
  notFound: {
    metaTitle: 'Page not found — Piloti',
    metaDescription: 'This page does not exist.',
    heading: 'This sheet is not in the drawing set.',
    body: 'The page you are looking for does not exist, or has been moved or renamed.',
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
