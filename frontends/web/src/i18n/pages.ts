/**
 * The copy of the two argument pages: why Piloti (/warum-piloti/) and the
 * comparison with Reiner AI (/piloti-vs-reiner-ai/). Kept out of ui.ts because
 * each is a page of prose, not interface strings; the titles and descriptions
 * stay in ui.ts `seo.pages` with every other page's.
 *
 * Same rules as ui.ts: both locales, German typography, and only what the
 * product does (each capability below shipped and is in the changelog). The
 * typography and claims lints read this file.
 *
 * What a competitor offers is stated as its own website states it, with the
 * month we read it, and never better or worse than it says. A comparison that
 * shades the other side is the one a buyer stops trusting halfway down.
 */
import type { Locale } from './ui'

interface Row {
  label: string
  a: string
  b: string
}

const de = {
  why: {
    heading: 'Warum Piloti? Weil keine Planungsfrage nur eine Quelle hat.',
    lede: 'Die Stelle im Gesetz, der Plan von 2019, die Auflage vom Amt. Piloti bringt sie in eine Antwort, mit Quellen, die Sie am Original prüfen, bevor die Entscheidung ins Projekt geht.',
    ctaPrimary: 'Mit einer echten Frage testen',
    ctaSecondary: 'Neuerungen ansehen',
    audiences: {
      title: 'Für wen Piloti gebaut ist',
      items: [
        {
          who: 'Büroleitung',
          need: 'Weniger Risiko in der Einreichung und Wissen, das nicht mit einer Person in Pension geht.',
          gets: 'Ein Büroarchiv, das jede Planer:in fragen kann, und Antworten, deren Fundstelle im Akt steht.',
        },
        {
          who: 'Projektleitung',
          need: 'Eine belastbare Antwort, bevor das Planungsgespräch beginnt, nicht nach drei Tagen Recherche.',
          gets: 'Die geltende Vorschrift, die Lage im eigenen Projekt und die möglichen Wege, begründet.',
        },
        {
          who: 'Planer:innen im Team',
          need: 'Nicht bei jeder Frage zur Gebäudeklasse oder zum Fluchtweg die erfahrene Kollegin unterbrechen.',
          gets: 'Eine Antwort mit Paragraf, Punkt oder Seite, die man am Original nachliest und dabei lernt.',
        },
        {
          who: 'Wer über Daten entscheidet',
          need: 'Klarheit, wohin Pläne und Unterlagen gehen, bevor ein Werkzeug ins Büro kommt.',
          gets: 'Kein Training mit Ihren Daten, Pläne bleiben Eigentum des Büros, und jeder beteiligte Anbieter steht offen in der Datenschutzerklärung.',
        },
      ],
    },
    chatgpt: {
      title: 'Warum nicht einfach ChatGPT?',
      body: 'ChatGPT beantwortet Fragen. Piloti beantwortet sie im Zusammenhang Ihres Projekts: mit Ihren Unterlagen, dem österreichischen Baurecht und Quellen, die Sie prüfen können. Ein allgemeines Sprachmodell ist ein gutes Werkzeug für Texte. Für eine Frage, deren Antwort in eine Einreichung geht, fehlt ihm dreierlei: die richtige Fassung, Ihr Projekt und der Beleg.',
      headA: 'Allgemeiner Chatbot',
      headB: 'Piloti',
      rows: [
        {
          label: 'Rechtsgrundlage',
          a: 'Was im Training stand, ohne Stand und oft ohne Bundesland',
          b: 'Landesbauordnungen aus dem RIS und die OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt',
        },
        {
          label: 'Beleg',
          a: 'Eine Quelle, wenn man danach fragt, und nicht immer eine, die es gibt',
          b: 'Jede Fundstelle wird gegen den Quelltext geprüft, bevor sie erscheint, und öffnet an der markierten Stelle',
        },
        {
          label: 'Ihr Projekt',
          a: 'Was Sie in dieses eine Gespräch hochladen',
          b: 'Pläne, Bescheide und Raumprogramme im Projekt, für das ganze Team, mit Fassungen und Freigabe',
        },
        {
          label: 'Pläne',
          a: 'Liest den Text eines PDFs',
          b: 'Sieht Grundriss und Schnitt als Bild an und markiert, welche Zeichnung auf dem Blatt gelesen wurde',
        },
        {
          label: 'Bürowissen',
          a: 'Kennt Ihr Archiv nicht',
          b: 'Durchsucht das Archiv Ihres Büros, getrennt von jedem anderen Büro',
        },
        {
          label: 'Was fehlt',
          a: 'Antwortet auch ohne die Unterlage, auf die es ankommt',
          b: 'Sagt, wenn etwa der Bebauungsplan fehlt, statt zu antworten, als hätte es ihn gelesen',
        },
      ] as Row[],
    },
    stages: {
      title: 'Vom Finden zum Weitertragen',
      body: 'Eine Antwort ist erst der Anfang. Piloti begleitet eine Frage bis dorthin, wo sie im Projekt etwas ändert.',
      items: [
        {
          step: '01',
          name: 'Finden',
          question: '„Welche Vorschrift gilt hier?“',
          body: 'Die geltende Stelle aus Baurecht, Büroarchiv und Projekt, mit Fundstelle bis auf Paragraf, Punkt oder Seite. Anschlussfragen wie „und in Gebäudeklasse 4?“ beantwortet Piloti aus dem, was es schon gelesen hat.',
        },
        {
          step: '02',
          name: 'Verstehen',
          question: '„Was heißt das für unser Projekt?“',
          body: 'Piloti legt die Vorschrift neben Ihre Pläne und Unterlagen, zeigt Prüfungen als Tabelle mit Ergebnis je Zeile und vergleicht Varianten, zwei Entwurfslösungen oder Bestand und Umbau, nebeneinander.',
        },
        {
          step: '03',
          name: 'Weitertragen',
          question: '„Was müssen wir ändern, dokumentieren, nachverfolgen?“',
          body: 'Aus der Antwort wird ein Aktenvermerk, eine Checkliste oder ein Prüfbericht im Projekt. Offene Befunde werden zu Aufgaben, fertige Dokumente gehen zur Freigabe, und jede Antwort lässt sich als Word-Dokument ablegen.',
        },
      ],
    },
    moat: {
      title: 'Was mit jedem Projekt wächst',
      body: 'Das Sprachmodell darunter können alle kaufen. Was Piloti ausmacht, liegt darüber, und es wird mit jedem Projekt Ihres Büros besser:',
      items: [
        { name: 'Österreichisches Baurecht', body: 'Landesbauordnungen, OIB-Richtlinien und ein Normenverzeichnis.' },
        { name: 'Ihr Projekt', body: 'Pläne, Bescheide und Auflagen, dort abgelegt, wo das Team arbeitet.' },
        { name: 'Ihr Büro', body: 'Wie Ihr Büro Dinge löst: Standards, Details und Erfahrung aus früheren Projekten.' },
        { name: 'Arbeitsweisen', body: 'Gebäudeklasse, Brandschutz, Einreichcheck, Bestand: eingebaute Abläufe, die Ihr Büro um eigene ergänzt.' },
        { name: 'Projektgedächtnis', body: 'Was in einem Projekt geklärt ist, geht als Fakt oder offener Punkt in die nächste Antwort ein.' },
        { name: 'Lernen aus Kritik', body: 'Eine als nicht hilfreich markierte Antwort wird anonymisiert zur Lektion, die jede spätere Antwort liest.' },
      ],
    },
    honest: {
      title: 'Was Piloti nicht ist',
      items: [
        'Keine Rechtsberatung und kein Ersatz für die Behörde. Die Verantwortung für die Planung bleibt bei Ihnen, und genau dafür stehen die Quellen an jeder Antwort.',
        'Kein fertiges Produkt von der Stange. Piloti ist ein Proof of Concept, den wir mit wenigen Pilotbüros an echten Fragen erproben.',
        'Kein Versprechen zum Datenstandort. Die Anmeldung läuft über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können. Wir trainieren keine Modelle mit Ihren Daten.',
      ],
      link: 'Details in der Datenschutzerklärung',
    },
    velocity: {
      title: 'Piloti wird jede Woche besser.',
      // {notes} and {weeks} are counted from the changelog at build time.
      body: '{notes} Neuerungen in {weeks} Wochen, jede im Changelog nachzulesen. Was als Nächstes kommt, bestimmen die Pilotbüros mit.',
      link: 'Alle Neuerungen',
    },
    compare: {
      title: 'Piloti im Vergleich',
      body: 'Sie prüfen gerade mehrere KI-Werkzeuge für Ihr Büro? Der ehrliche Vergleich mit Reiner AI, auch dort, wo Reiner vorn liegt.',
      link: 'Piloti oder Reiner AI',
    },
  },
  vsReiner: {
    heading: 'Piloti oder Reiner AI?',
    lede: 'Beide sind KI-Werkzeuge für Planungsbüros. Sie sind für verschiedene Märkte und verschiedene Aufgaben gebaut. Hier der Vergleich, auch dort, wo Reiner AI vorn liegt.',
    // People search for it misspelt; say once which product this page means.
    nameNote: 'Gemeint ist Reiner AI (reiner.ai) aus Deutschland, oft auch als „Rainer AI“ gesucht.',
    shortTitle: 'Die kurze Antwort',
    short: [
      {
        label: 'Piloti passt',
        body: 'wenn Sie in Österreich planen und Ihre Fragen an Baurecht, Plänen und dem Wissen Ihres Büros hängen: Welche Vorschrift gilt, was heißt sie für dieses Projekt, und wie kommt die Entscheidung in den Akt.',
      },
      {
        label: 'Reiner AI passt',
        body: 'wenn Sie in Deutschland arbeiten und fertige Agenten für wiederkehrende Dokumente suchen: Baubesprechungsprotokolle, Leistungsverzeichnisse, VOB-Nachträge, Schlussrechnungen und HOAI-Verträge.',
      },
    ],
    tableTitle: 'Im Detail',
    headA: 'Piloti',
    headB: 'Reiner AI',
    rows: [
      {
        label: 'Markt',
        a: 'Österreich',
        b: 'Deutschland',
      },
      {
        label: 'Regelwerke',
        a: 'Landesbauordnungen aus dem RIS, OIB-Richtlinien, Normenverzeichnis',
        b: 'Nennt LBO, HOAI, VOB, DIN und DWA; auf der Website weder OIB-Richtlinien noch österreichisches Landesrecht',
      },
      {
        label: 'Schwerpunkt',
        a: 'Planungsfragen im Projekt, belegt, bis zum Aktenvermerk und zur Freigabe',
        b: 'Chat und Agenten für Bau- und Vertragsdokumente, laut Website über 50 Aufgaben',
      },
      {
        label: 'Belege',
        a: 'Fundstelle bis auf Paragraf, Punkt oder Seite, vor dem Anzeigen gegen den Quelltext geprüft',
        b: '„Referenzen auf einen Klick“ zu den verarbeiteten Textstellen',
      },
      {
        label: 'Pläne',
        a: 'Sieht Grundriss und Schnitt als Bild an und markiert die gelesene Zeichnung',
        b: 'Agent „Planprüfer“: prüft Pläne auf Vollständigkeit, formale Anforderungen und Normenkonformität',
      },
      {
        label: 'Projektarbeit',
        a: 'Projekte mit Dateien, Fassungen, Freigabe, Projektgedächtnis und geplanten Aufgaben',
        b: 'Getrennte Projektdaten, Anbindung von SharePoint und Google Drive',
      },
      {
        label: 'Hosting',
        a: 'Anmeldung über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, auch außerhalb der EU',
        b: 'Server in Frankfurt, laut Website Entwicklung und Infrastruktur in Deutschland',
      },
      {
        label: 'Training',
        a: 'Kein Training mit Ihren Daten',
        b: '„Zero-Training Policy“',
      },
      {
        label: 'Preis',
        a: 'Noch keine Preisliste; Bedingungen je Pilotbüro',
        b: '49, 99 oder 299 € je Nutzer:in und Monat bei jährlicher Abrechnung, 7 Tage kostenlos testen',
      },
      {
        label: 'Stand',
        a: 'Proof of Concept mit ausgewählten Pilotbüros',
        b: 'Am Markt, mit Finanzierung',
      },
    ] as Row[],
    source: 'Angaben zu Reiner AI laut reiner.ai, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
    theirsTitle: 'Wo Reiner AI vorn liegt',
    theirs: [
      'Server in Deutschland. Wer für seine Daten einen Standort in Deutschland braucht, bekommt ihn bei Reiner, bei Piloti heute nicht.',
      'Offene Preise und ein Test ohne Gespräch. Bei Piloti beginnt es mit einem Gespräch.',
      'Fertige Agenten für Bauleitung und Vergabe, vom Protokoll bis zur Schlussrechnung.',
      'Ein Unternehmen am Markt. Piloti ist in Gründung und in der Pilotphase.',
    ],
    oursTitle: 'Wo Piloti vorn liegt',
    ours: [
      'Österreichisches Baurecht als Grundlage, nicht als Nachtrag: Landesbauordnungen aus dem RIS und OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt.',
      'Das Projekt als Arbeitsort. Pläne, Bescheide und Antworten liegen dort, wo das Team arbeitet, mit Fassungen, Freigabe und einem Gedächtnis dafür, was schon geklärt ist.',
      'Eine Frage wird zu Arbeit: Tiefenrecherche mit Bericht im Projekt, Befunde als offene Punkte, Aktenvermerke zur Freigabe.',
    ],
    closeTitle: 'Selbst vergleichen',
    close: 'Die ehrlichste Probe ist eine echte Frage. Schicken Sie uns eine aus einem laufenden Projekt, gern dieselbe, die Sie auch Reiner AI stellen. Wir zeigen Ihnen, wie Piloti sie beantwortet.',
    ctaSecondary: 'Warum Piloti',
  },
}

const en: typeof de = {
  why: {
    heading: 'Why Piloti? Because no planning question has only one source.',
    lede: 'The clause in the code, the drawing from 2019, the condition from the authority. Piloti brings them into one answer, with sources you check against the original before the decision goes into the project.',
    ctaPrimary: 'Try it with a real question',
    ctaSecondary: 'See what’s new',
    audiences: {
      title: 'Who Piloti is built for',
      items: [
        {
          who: 'Office principals',
          need: 'Less risk in the permit submission, and knowledge that does not retire with one person.',
          gets: 'An office archive every planner can ask, and answers whose source goes on file.',
        },
        {
          who: 'Project leads',
          need: 'A sound answer before the design meeting starts, not after three days of research.',
          gets: 'The rule that applies, where the project stands against it, and the options, with reasons.',
        },
        {
          who: 'Planners on the team',
          need: 'Not interrupting the senior colleague for every question on building class or escape routes.',
          gets: 'An answer with section, clause or page that you read in the original, and learn from.',
        },
        {
          who: 'Whoever decides on data',
          need: 'Clarity on where drawings and documents go before a tool comes into the office.',
          gets: 'No training on your data, drawings stay the office’s property, and every provider involved is named in the privacy policy.',
        },
      ],
    },
    chatgpt: {
      title: 'Why not just use ChatGPT?',
      body: 'ChatGPT answers questions. Piloti answers them in the context of your project: with your documents, Austrian building law and sources you can check. A general language model is a good tool for text. For a question whose answer goes into a permit submission it lacks three things: the right edition, your project and the evidence.',
      headA: 'General chatbot',
      headB: 'Piloti',
      rows: [
        {
          label: 'Legal basis',
          a: 'Whatever was in its training, undated and often without the state',
          b: 'State building codes from RIS and the OIB guidelines, cited the way an official decision cites them',
        },
        {
          label: 'Evidence',
          a: 'A source if you ask for one, and not always one that exists',
          b: 'Every citation is checked against the source text before it appears, and opens at the marked passage',
        },
        {
          label: 'Your project',
          a: 'Whatever you upload to this one conversation',
          b: 'Drawings, permits and room schedules in the project, for the whole team, with versions and approval',
        },
        {
          label: 'Drawings',
          a: 'Reads the text of a PDF',
          b: 'Looks at plan and section as an image and marks which drawing on the sheet it read',
        },
        {
          label: 'Office knowledge',
          a: 'Does not have your archive',
          b: 'Searches your office’s archive, kept apart from every other office',
        },
        {
          label: 'What is missing',
          a: 'Answers even without the document that matters',
          b: 'Says when, for example, the zoning plan is missing, instead of answering as if it had read it',
        },
      ] as Row[],
    },
    stages: {
      title: 'From finding to following through',
      body: 'An answer is only the start. Piloti carries a question to the point where it changes something in the project.',
      items: [
        {
          step: '01',
          name: 'Find',
          question: '“Which rule applies here?”',
          body: 'The passage that applies, from building law, the office archive and the project, cited down to section, clause or page. Follow-ups like “and in building class 4?” are answered from what Piloti has already read.',
        },
        {
          step: '02',
          name: 'Understand',
          question: '“What does it mean for our project?”',
          body: 'Piloti sets the rule beside your drawings and documents, lays out checks as a table with a result on each row, and compares options, two design solutions or existing and altered, side by side.',
        },
        {
          step: '03',
          name: 'Follow through',
          question: '“What do we change, record, follow up?”',
          body: 'The answer becomes a file note, a checklist or a review report in the project. Open findings become tasks, finished documents go for approval, and any answer can be filed as a Word document.',
        },
      ],
    },
    moat: {
      title: 'What grows with every project',
      body: 'Anyone can buy the language model underneath. What makes Piloti sits above it, and it gets better with every project your office runs:',
      items: [
        { name: 'Austrian building law', body: 'State building codes, OIB guidelines and a register of standards.' },
        { name: 'Your project', body: 'Drawings, permits and conditions, filed where the team works.' },
        { name: 'Your office', body: 'How your office solves things: standards, details and experience from past projects.' },
        { name: 'Ways of working', body: 'Building class, fire safety, submission check, existing buildings: built-in procedures your office extends with its own.' },
        { name: 'Project memory', body: 'What a project has settled goes into the next answer as a fact or an open point.' },
        { name: 'Learning from criticism', body: 'An answer marked unhelpful becomes an anonymised lesson that every later answer reads.' },
      ],
    },
    honest: {
      title: 'What Piloti is not',
      items: [
        'Not legal advice and not a substitute for the authority. Responsibility for the design stays with you, which is exactly why every answer carries its sources.',
        'Not a finished off-the-shelf product. Piloti is a proof of concept we are trialling with a few pilot offices on real questions.',
        'Not a promise about data location. Sign-in runs through WorkOS (USA), AI requests through OpenRouter (USA) to model providers that may be based outside the EU. We do not train models on your data.',
      ],
      link: 'Details in the privacy policy',
    },
    velocity: {
      title: 'Piloti gets better every week.',
      body: '{notes} changes in {weeks} weeks, each one in the changelog. The pilot offices help decide what comes next.',
      link: 'Everything that’s new',
    },
    compare: {
      title: 'Piloti compared',
      body: 'Weighing several AI tools for your office? The honest comparison with Reiner AI, including where Reiner is ahead.',
      link: 'Piloti or Reiner AI',
    },
  },
  vsReiner: {
    heading: 'Piloti or Reiner AI?',
    lede: 'Both are AI tools for planning offices. They are built for different markets and different jobs. Here is the comparison, including where Reiner AI is ahead.',
    nameNote: 'This means Reiner AI (reiner.ai) from Germany, often searched for as “Rainer AI”.',
    shortTitle: 'The short answer',
    short: [
      {
        label: 'Piloti fits',
        body: 'if you plan in Austria and your questions hinge on building law, drawings and your office’s knowledge: which rule applies, what it means for this project, and how the decision gets on file.',
      },
      {
        label: 'Reiner AI fits',
        body: 'if you work in Germany and want ready-made agents for recurring documents: site meeting minutes, bills of quantities, VOB change orders, final invoices and HOAI contracts.',
      },
    ],
    tableTitle: 'In detail',
    headA: 'Piloti',
    headB: 'Reiner AI',
    rows: [
      { label: 'Market', a: 'Austria', b: 'Germany' },
      {
        label: 'Regulations',
        a: 'State building codes from RIS, OIB guidelines, register of standards',
        b: 'Names LBO, HOAI, VOB, DIN and DWA; its website mentions neither the OIB guidelines nor Austrian state law',
      },
      {
        label: 'Focus',
        a: 'Planning questions in the project, with evidence, through to the file note and approval',
        b: 'Chat and agents for construction and contract documents, over 50 tasks according to its website',
      },
      {
        label: 'Evidence',
        a: 'Citation down to section, clause or page, checked against the source text before it is shown',
        b: '“References in one click” to the passages it processed',
      },
      {
        label: 'Drawings',
        a: 'Looks at plan and section as an image and marks the drawing it read',
        b: '“Planprüfer” agent: checks drawings for completeness, formal requirements and conformity with standards',
      },
      {
        label: 'Project work',
        a: 'Projects with files, versions, approval, project memory and scheduled tasks',
        b: 'Separated project data, SharePoint and Google Drive connectors',
      },
      {
        label: 'Hosting',
        a: 'Sign-in through WorkOS (USA), AI requests through OpenRouter (USA) to model providers, some outside the EU',
        b: 'Servers in Frankfurt; development and infrastructure in Germany, according to its website',
      },
      { label: 'Training', a: 'No training on your data', b: '“Zero-Training Policy”' },
      {
        label: 'Price',
        a: 'No price list yet; terms agreed with each pilot office',
        b: '€49, €99 or €299 per user per month billed annually, 7-day free trial',
      },
      { label: 'Stage', a: 'Proof of concept with selected pilot offices', b: 'On the market, funded' },
    ] as Row[],
    source: 'Reiner AI details as stated on reiner.ai, read in September 2026. If something has changed, write to us and we will correct it.',
    theirsTitle: 'Where Reiner AI is ahead',
    theirs: [
      'Servers in Germany. If your data must stay in Germany, Reiner offers that and Piloti does not today.',
      'Public prices and a trial without a conversation. With Piloti it starts with a conversation.',
      'Ready-made agents for site management and tendering, from minutes to the final invoice.',
      'A company on the market. Piloti is being founded and is in its pilot phase.',
    ],
    oursTitle: 'Where Piloti is ahead',
    ours: [
      'Austrian building law as the foundation, not an add-on: state building codes from RIS and the OIB guidelines, cited the way an official decision cites them.',
      'The project as the place of work. Drawings, permits and answers sit where the team works, with versions, approval and a memory of what is already settled.',
      'A question becomes work: in-depth research with a report filed in the project, findings as open points, file notes sent for approval.',
    ],
    closeTitle: 'Compare for yourself',
    close: 'The fairest test is a real question. Send us one from a current project, ideally the same one you put to Reiner AI. We will show you how Piloti answers it.',
    ctaSecondary: 'Why Piloti',
  },
}

export const pages: Record<Locale, typeof de> = { de, en }
