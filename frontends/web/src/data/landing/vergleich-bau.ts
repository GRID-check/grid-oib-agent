/**
 * Piloti next to AI tools built for construction and planning. Each column on
 * the other side says only what that vendor's own site says, read in the month
 * `checked` names; where the other tool is ahead, the page says so first.
 */
import type { LandingEntry } from '../../lib/landing'

export const vergleichBau: LandingEntry[] = [
  {
    slug: 'reiner-ai',
    checked: '2026-09',
    related: ['vergleich/weka-bau-ai', 'vergleich/chatgpt', 'baurecht/wien', 'anwendungen/einreichcheck'],
    de: {
      title: 'Reiner AI Alternative für Österreich: Piloti im Vergleich',
      description:
        'Piloti oder Reiner AI (oft „Rainer AI“ gesucht)? Markt, Regelwerke, Belege, Projektarbeit, Hosting und Preise im Vergleich, auch wo Reiner vorn liegt.',
      heading: 'Piloti oder Reiner AI?',
      lede: 'Beide sind KI-Werkzeuge für Planungsbüros. Sie sind für verschiedene Märkte und verschiedene Aufgaben gebaut. Hier der Vergleich, auch dort, wo Reiner AI vorn liegt.',
      note: 'Gemeint ist Reiner AI (reiner.ai) aus Deutschland, oft auch als „Rainer AI“ gesucht. Angaben zu Reiner AI laut reiner.ai.',
      answer:
        'Planen Sie in Österreich und hängen Ihre Fragen an Landesbauordnungen, OIB-Richtlinien und Ihren Plänen, passt Piloti. Arbeiten Sie in Deutschland und suchen fertige Agenten für Protokolle, Leistungsverzeichnisse, VOB-Nachträge und HOAI, passt Reiner AI.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Reiner AI',
          rows: [
            { label: 'Markt', a: 'Österreich', b: 'Deutschland' },
            {
              label: 'Regelwerke',
              a: 'Die neun Landesbauordnungen aus dem RIS, OIB-Richtlinien, Normenverzeichnis',
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
            { label: 'Training', a: 'Kein Training mit Ihren Daten', b: '„Zero-Training Policy“' },
            {
              label: 'Preis',
              a: 'Noch keine Preisliste; Bedingungen je Pilotbüro',
              b: '49, 99 oder 299 € je Nutzer:in und Monat bei jährlicher Abrechnung, 7 Tage kostenlos testen',
            },
            { label: 'Stand', a: 'Proof of Concept mit ausgewählten Pilotbüros', b: 'Am Markt, mit Finanzierung' },
          ],
          note: 'Angaben zu Reiner AI laut reiner.ai, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Reiner AI vorn liegt',
            items: [
              'Server in Deutschland. Wer für seine Daten einen Standort in Deutschland braucht, bekommt ihn bei Reiner, bei Piloti heute nicht.',
              'Offene Preise und ein Test ohne Gespräch. Bei Piloti beginnt es mit einem Gespräch.',
              'Fertige Agenten für Bauleitung und Vergabe, vom Protokoll bis zur Schlussrechnung.',
              'Ein Unternehmen am Markt. Piloti ist in Gründung und in der Pilotphase.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Baurecht als Grundlage, nicht als Nachtrag: Landesbauordnungen aus dem RIS und OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt.',
              'Das Projekt als Arbeitsort. Pläne, Bescheide und Antworten liegen dort, wo das Team arbeitet, mit Fassungen, Freigabe und einem Gedächtnis dafür, was schon geklärt ist.',
              'Eine Frage wird zu Arbeit: Tiefenrecherche mit Bericht im Projekt, Befunde als offene Punkte, Aktenvermerke zur Freigabe.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Warum der Markt den Unterschied macht',
          body: [
            'Baurecht ist in Deutschland wie in Österreich Landesrecht, aber es sind andere Länder und andere Gesetze. Eine deutsche Landesbauordnung, die DIN und die VOB helfen einem Büro in Graz oder Linz nicht weiter. In Österreich hängen die technischen Anforderungen an den OIB-Richtlinien, die jedes Bundesland in seiner eigenen Ausgabe für verbindlich erklärt.',
            'Ein Werkzeug für österreichische Projekte muss deshalb wissen, welches Bundesland gilt, und die Fundstelle so nennen, dass Sie sie im RIS wiederfinden. Genau darauf ist Piloti gebaut.',
          ],
        },
      ],
      faq: [
        {
          q: 'Gibt es Reiner AI für Österreich?',
          a: 'Auf reiner.ai werden deutsche Regelwerke wie LBO, HOAI, VOB, DIN und DWA genannt, aber weder die OIB-Richtlinien noch österreichisches Landesrecht (Stand September 2026). Für Projekte in Österreich ist Piloti gebaut: mit den neun Landesbauordnungen aus dem RIS und den OIB-Richtlinien.',
        },
        {
          q: 'Ist „Rainer AI“ dasselbe wie Reiner AI?',
          a: 'Ja, gemeint ist in aller Regel Reiner AI (reiner.ai), eine KI-Plattform für Bauplanung aus Deutschland. Der Name wird oft mit „a“ gesucht.',
        },
        {
          q: 'Was kostet Reiner AI im Vergleich zu Piloti?',
          a: 'Reiner AI nennt auf seiner Website 49, 99 oder 299 € je Nutzer:in und Monat bei jährlicher Abrechnung. Piloti hat noch keine Preisliste: Während der Pilotphase werden die Bedingungen mit jedem Pilotbüro einzeln vereinbart.',
        },
        {
          q: 'Wo werden die Daten verarbeitet?',
          a: 'Reiner AI gibt Server in Frankfurt an. Bei Piloti läuft die Anmeldung über WorkOS (USA), KI-Anfragen gehen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können. Beide trainieren laut eigener Angabe keine Modelle mit Kundendaten.',
        },
      ],
    },
    en: {
      title: 'Reiner AI alternative for Austria: Piloti compared',
      description:
        'Piloti or Reiner AI (often searched as “Rainer AI”)? Market, regulations, evidence, project work, hosting and prices compared, including where Reiner is ahead.',
      heading: 'Piloti or Reiner AI?',
      lede: 'Both are AI tools for planning offices. They are built for different markets and different jobs. Here is the comparison, including where Reiner AI is ahead.',
      note: 'This means Reiner AI (reiner.ai) from Germany, often searched for as “Rainer AI”. Reiner AI details as stated on reiner.ai.',
      answer:
        'If you plan in Austria and your questions hinge on state building codes, the OIB guidelines and your drawings, Piloti fits. If you work in Germany and want ready-made agents for minutes, bills of quantities, VOB change orders and HOAI, Reiner AI fits.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Reiner AI',
          rows: [
            { label: 'Market', a: 'Austria', b: 'Germany' },
            {
              label: 'Regulations',
              a: 'The nine state building codes from RIS, OIB guidelines, register of standards',
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
          ],
          note: 'Reiner AI details as stated on reiner.ai, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where Reiner AI is ahead',
            items: [
              'Servers in Germany. If your data must stay in Germany, Reiner offers that and Piloti does not today.',
              'Public prices and a trial without a conversation. With Piloti it starts with a conversation.',
              'Ready-made agents for site management and tendering, from minutes to the final invoice.',
              'A company on the market. Piloti is being founded and is in its pilot phase.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian building law as the foundation, not an add-on: state building codes from RIS and the OIB guidelines, cited the way an official decision cites them.',
              'The project as the place of work. Drawings, permits and answers sit where the team works, with versions, approval and a memory of what is already settled.',
              'A question becomes work: in-depth research with a report filed in the project, findings as open points, file notes sent for approval.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Why the market makes the difference',
          body: [
            'Building law is state law in Germany and in Austria alike, but they are different states and different laws. A German state building code, DIN and VOB do not help an office in Graz or Linz. In Austria the technical requirements hinge on the OIB guidelines, which each state declares binding in its own edition.',
            'A tool for Austrian projects therefore has to know which state applies, and cite the passage so you find it again in RIS. That is what Piloti is built for.',
          ],
        },
      ],
      faq: [
        {
          q: 'Is Reiner AI available for Austria?',
          a: 'reiner.ai names German regulations such as LBO, HOAI, VOB, DIN and DWA, but neither the OIB guidelines nor Austrian state law (as of September 2026). Piloti is built for projects in Austria: with the nine state building codes from RIS and the OIB guidelines.',
        },
        {
          q: 'Is “Rainer AI” the same as Reiner AI?',
          a: 'Yes, it almost always means Reiner AI (reiner.ai), an AI platform for building design from Germany. The name is often searched with an “a”.',
        },
        {
          q: 'What does Reiner AI cost compared with Piloti?',
          a: 'Reiner AI lists €49, €99 or €299 per user per month billed annually on its website. Piloti has no price list yet: during the pilot phase, terms are agreed with each pilot office individually.',
        },
        {
          q: 'Where is the data processed?',
          a: 'Reiner AI states servers in Frankfurt. With Piloti, sign-in runs through WorkOS (USA) and AI requests go through OpenRouter (USA) to model providers that may be based outside the EU. Both say they do not train models on customer data.',
        },
      ],
    },
  },
  {
    slug: 'weka-bau-ai',
    checked: '2026-09',
    related: ['vergleich/reiner-ai', 'vergleich/bauki', 'baurecht/steiermark', 'anwendungen/pruefbericht-aktenvermerk'],
    de: {
      title: 'WEKA Bau AI Alternative für Österreich: Piloti im Vergleich',
      description:
        'Piloti oder WEKA Bau AI? Quellen, Regelwerke, Belege, Projektarbeit, Hosting und Preis im Vergleich, auch wo WEKA vorn liegt – für Büros in Österreich.',
      heading: 'Piloti oder WEKA Bau AI?',
      lede: 'WEKA Bau AI antwortet aus der Fachdatenbank eines etablierten Verlags. Piloti arbeitet mit dem Gesetzestext, den OIB-Richtlinien und den Unterlagen Ihres Projekts. Hier der Vergleich, auch dort, wo WEKA vorn liegt.',
      note: 'Gemeint ist WEKA Bau AI der WEKA Media GmbH & Co. KG aus Deutschland. Angaben laut weka.de, shop.weka.de und der WEKA-Pressemitteilung vom 4. Februar 2026.',
      answer:
        'Arbeiten Sie in Deutschland und brauchen redaktionell geprüftes Fachwissen zu VOB, BGB und HOAI samt Entwürfen für E-Mails, Verträge und Nachträge, passt WEKA Bau AI. Planen Sie in Österreich und hängen Ihre Fragen an Landesbauordnung, OIB-Richtlinien und Ihren eigenen Plänen, passt Piloti.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'WEKA Bau AI',
          rows: [
            {
              label: 'Markt',
              a: 'Planungsbüros in Österreich',
              b: 'Deutschland; für „Bauunternehmer, Bauleiter, Architekten, Ingenieure und Planer“',
            },
            {
              label: 'Woraus es antwortet',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Ihr Büroarchiv, die Unterlagen des Projekts, Webrecherche mit verlinkter Quelle',
              b: 'Ausschließlich die WEKA-Datenbank mit „rund 20.000 Fachartikeln“',
            },
            {
              label: 'Regelwerke',
              a: 'Die neun Landesbauordnungen, OIB-Richtlinien, Bundesgesetze wie ASchG, Arbeitsstättenverordnung und Denkmalschutzgesetz',
              b: 'BGB, VOB/A/B/C, LBO, VgV, BauGB, BauNVO, HOAI, DIN-Normen; Österreich, OIB-Richtlinien und ÖNORM werden nicht genannt',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis auf Paragraf oder Punkt, vor dem Anzeigen gegen den Quelltext geprüft; RIS-Quellen öffnen an der markierten Stelle',
              b: '„Transparente Quellenangaben“, im Volltext des Fachartikels überprüfbar',
            },
            {
              label: 'Entwürfe',
              a: 'Aktenvermerk, Protokoll, Checkliste, Flächenaufstellung, im Gespräch überarbeitet; jede Antwort als Word',
              b: 'E-Mails, Verträge, Nachträge und Dokumente; Export als Word und PDF, Archiv',
            },
            {
              label: 'Projektarbeit',
              a: 'Projekte mit Plänen, Fassungen, Freigabe, Aufgaben und einem Gedächtnis für Geklärtes und Offenes',
              b: 'Auf den gelesenen Seiten nicht beschrieben',
            },
            {
              label: 'Hosting',
              a: 'Anmeldung über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, auch außerhalb der EU',
              b: 'Microsoft Azure, keine Speicherung der Prompts, ISO/IEC 27001',
            },
            {
              label: 'Preis',
              a: 'Noch keine Preisliste; Bedingungen je Pilotbüro',
              b: '499,00 € netto im Jahr, Jahreslizenz, 200 Anfragen pro Monat und Nutzer:in, 14 Tage kostenlos testen',
            },
            { label: 'Stand', a: 'Proof of Concept mit ausgewählten Pilotbüros', b: 'Am Markt, von einem etablierten Fachverlag' },
          ],
          note: 'Angaben zu WEKA Bau AI laut weka.de/bi/ai, shop.weka.de/bau-ai und der Pressemitteilung vom 4. Februar 2026, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo WEKA Bau AI vorn liegt',
            items: [
              'Kuratierte Fachinhalte. Hinter den Antworten stehen Artikel, die eine Redaktion geschrieben und gepflegt hat. Piloti hat keine Redaktion, die Kommentare zum Gesetz schreibt.',
              'Deutsches Bauvertragsrecht. VOB und BGB sind bei WEKA Kernthema; Piloti arbeitet mit österreichischem Bau- und Bautechnikrecht, nicht mit deutschem Vertragsrecht.',
              'Offener Preis und 14 Tage Test ohne Gespräch. Bei Piloti beginnt es mit einem Gespräch.',
              'Ein etablierter Verlag. Piloti ist in Gründung und in der Pilotphase.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Baurecht aus der Primärquelle: Landesbauordnung aus dem RIS und OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt.',
              'Ihre eigenen Unterlagen zählen. Büroarchiv und Projektdokumente sind Quellen, und Piloti sieht Grundriss und Schnitt als Bild an.',
              'Das Projekt als Arbeitsort: Aufgaben laufen unter Ihrem Namen, Befunde werden zu offenen Punkten, Entwürfe gehen in die Freigabe.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Fachartikel oder Gesetzestext?',
          body: [
            'Die beiden Werkzeuge setzen an verschiedenen Stellen an. WEKA Bau AI antwortet aus Fachartikeln: Jemand hat die Norm schon gelesen, eingeordnet und erklärt. Das ist bei Vertragsfragen und zur Orientierung viel wert, und es ist der Kern eines Fachverlags.',
            'Die Behörde zitiert im Bescheid aber nicht den Artikel, sondern das Gesetz und die Richtlinie. In Österreich kommt dazu, dass jedes Bundesland die OIB-Richtlinien in seiner eigenen Ausgabe für verbindlich erklärt. Piloti fragt deshalb nach dem Bundesland oder nennt die Annahme, liest den Gesetzestext selbst und zeigt die Stelle, an der Sie nachprüfen.',
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti aufhört',
          items: [
            'Kein deutsches Recht: keine VOB, kein BGB, keine HOAI, keine DIN-Normen.',
            'Die ÖNORM-Texte selbst sind nicht enthalten, nur ein Verzeichnis der relevanten Normen.',
            'Keine redaktionellen Kommentare. Piloti belegt aus Gesetz, Richtlinie und Ihren Unterlagen, die Einordnung bleibt Ihre.',
            'Keine Zusage zum Datenstandort und noch keine Preisliste.',
          ],
        },
      ],
      faq: [
        {
          q: 'Gibt es WEKA Bau AI für Österreich?',
          a: 'WEKA nennt als abgedeckte Regelwerke BGB, VOB/A/B/C, LBO, VgV, BauGB, BauNVO, HOAI und DIN-Normen. Österreich, die OIB-Richtlinien und ÖNORM kommen auf den gelesenen Seiten nicht vor (Stand September 2026). Piloti ist für Projekte in Österreich gebaut.',
        },
        {
          q: 'Was kostet WEKA Bau AI?',
          a: 'Laut WEKA-Shop 499,00 € netto im Jahr als Jahreslizenz, mit 200 Anfragen pro Monat und Nutzer:in, und 14 Tage kostenlos zum Testen. Piloti hat noch keine Preisliste: In der Pilotphase werden die Bedingungen mit jedem Büro einzeln vereinbart.',
        },
        {
          q: 'Kann ich eigene Unterlagen verwenden?',
          a: 'WEKA Bau AI antwortet laut Anbieter nur aus der WEKA-Datenbank. Bei Piloti sind das Archiv Ihres Büros und die Dokumente des Projekts eigene Quellen; das Archiv sieht kein anderes Büro. Hochladen lassen sich PDF, Word, Excel, PowerPoint, CSV, Bilder und ganze Ordner.',
        },
        {
          q: 'Wo werden die Daten verarbeitet?',
          a: 'WEKA gibt Microsoft Azure an, speichert die Prompts laut eigener Angabe nicht und nennt ISO/IEC 27001. Bei Piloti läuft die Anmeldung über WorkOS (USA), KI-Anfragen gehen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können. Mit Büro-Daten werden keine Modelle trainiert.',
        },
      ],
    },
    en: {
      title: 'WEKA Bau AI alternative for Austria: Piloti compared',
      description:
        'Piloti or WEKA Bau AI? Sources, regulations, evidence, project work, hosting and price compared, including where WEKA is ahead – for offices in Austria.',
      heading: 'Piloti or WEKA Bau AI?',
      lede: 'WEKA Bau AI answers from an established publisher’s expert database. Piloti works with the legal text, the OIB guidelines and your project’s documents. Here is the comparison, including where WEKA is ahead.',
      note: 'This means WEKA Bau AI by WEKA Media GmbH & Co. KG from Germany. Details as stated on weka.de, shop.weka.de and WEKA’s press release of 4 February 2026.',
      answer:
        'If you work in Germany and need editorially reviewed expertise on VOB, BGB and HOAI plus drafts for e-mails, contracts and change orders, WEKA Bau AI fits. If you plan in Austria and your questions hinge on the state building code, the OIB guidelines and your own drawings, Piloti fits.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'WEKA Bau AI',
          rows: [
            {
              label: 'Market',
              a: 'Planning offices in Austria',
              b: 'Germany; for “contractors, site managers, architects, engineers and planners”',
            },
            {
              label: 'What it answers from',
              a: 'State law from RIS, OIB guidelines, register of standards, your office archive, the project’s documents, web research with linked sources',
              b: 'Only WEKA’s database of “around 20,000 expert articles”',
            },
            {
              label: 'Regulations',
              a: 'The nine state building codes, OIB guidelines, federal law such as ASchG, the workplace ordinance and the Monument Protection Act',
              b: 'BGB, VOB/A/B/C, LBO, VgV, BauGB, BauNVO, HOAI, DIN standards; Austria, the OIB guidelines and ÖNORM are not mentioned',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section or clause, checked against the source text before it is shown; RIS sources open at the marked passage',
              b: '“Transparent source references”, verifiable in the article’s full text',
            },
            {
              label: 'Drafts',
              a: 'File note, minutes, checklist, area schedule, revised in the conversation; every answer as Word',
              b: 'E-mails, contracts, change orders and documents; export as Word and PDF, archive',
            },
            {
              label: 'Project work',
              a: 'Projects with drawings, versions, approval, tasks and a memory of what is settled and what is open',
              b: 'Not described on the pages we read',
            },
            {
              label: 'Hosting',
              a: 'Sign-in through WorkOS (USA), AI requests through OpenRouter (USA) to model providers, some outside the EU',
              b: 'Microsoft Azure, no storage of prompts, ISO/IEC 27001',
            },
            {
              label: 'Price',
              a: 'No price list yet; terms agreed with each pilot office',
              b: '€499.00 net per year, annual licence, 200 requests per month per user, 14-day free trial',
            },
            { label: 'Stage', a: 'Proof of concept with selected pilot offices', b: 'On the market, from an established publisher' },
          ],
          note: 'WEKA Bau AI details as stated on weka.de/bi/ai, shop.weka.de/bau-ai and the press release of 4 February 2026, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where WEKA Bau AI is ahead',
            items: [
              'Curated expert content. The answers rest on articles an editorial team wrote and maintains. Piloti has no editorial team writing commentary on the law.',
              'German construction contract law. VOB and BGB are core topics at WEKA; Piloti works with Austrian building and building-technology law, not German contract law.',
              'A public price and a 14-day trial without a conversation. With Piloti it starts with a conversation.',
              'An established publisher. Piloti is being founded and is in its pilot phase.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian building law from the primary source: the state building code from RIS and the OIB guidelines, cited the way an official decision cites them.',
              'Your own documents count. The office archive and project documents are sources, and Piloti looks at plan and section as an image.',
              'The project as the place of work: tasks run under your name, findings become open points, drafts go out for approval.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Expert article or legal text?',
          body: [
            'The two tools start in different places. WEKA Bau AI answers from expert articles: someone has already read the rule, placed it and explained it. That is worth a lot for contract questions and for orientation, and it is the core of a specialist publisher.',
            'In its decision, though, the authority cites the law and the guideline, not the article. In Austria, each state also declares the OIB guidelines binding in its own edition. So Piloti asks for the state or states its assumption, reads the legal text itself and shows the passage where you check it.',
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops',
          items: [
            'No German law: no VOB, no BGB, no HOAI, no DIN standards.',
            'The ÖNORM texts themselves are not included, only a register of the relevant standards.',
            'No editorial commentary. Piloti cites law, guideline and your documents; the judgement stays yours.',
            'No promise on data location and no price list yet.',
          ],
        },
      ],
      faq: [
        {
          q: 'Is WEKA Bau AI available for Austria?',
          a: 'WEKA lists BGB, VOB/A/B/C, LBO, VgV, BauGB, BauNVO, HOAI and DIN standards as covered. Austria, the OIB guidelines and ÖNORM do not appear on the pages we read (as of September 2026). Piloti is built for projects in Austria.',
        },
        {
          q: 'What does WEKA Bau AI cost?',
          a: 'According to the WEKA shop, €499.00 net per year as an annual licence, with 200 requests per month per user, and a 14-day free trial. Piloti has no price list yet: during the pilot phase, terms are agreed with each office individually.',
        },
        {
          q: 'Can I use my own documents?',
          a: 'According to the vendor, WEKA Bau AI answers only from the WEKA database. With Piloti, your office archive and the project’s documents are sources in their own right; no other office sees the archive. You can upload PDF, Word, Excel, PowerPoint, CSV, images and whole folders.',
        },
        {
          q: 'Where is the data processed?',
          a: 'WEKA states Microsoft Azure, says it does not store prompts and cites ISO/IEC 27001. With Piloti, sign-in runs through WorkOS (USA) and AI requests go through OpenRouter (USA) to model providers that may be based outside the EU. No models are trained on office data.',
        },
      ],
    },
  },
  {
    slug: 'bauki',
    checked: '2026-09',
    related: ['vergleich/weka-bau-ai', 'vergleich/k24ai', 'baurecht/oberoesterreich', 'anwendungen/bueroarchiv'],
    de: {
      title: 'BauKI Alternative für Österreich: Piloti im Vergleich',
      description:
        'Piloti oder BauKI? Regelwerke, Belege, Wissensdatenbank, Prüfbericht, Hosting und Preise im Vergleich, auch wo BauKI vorn liegt – für Österreich.',
      heading: 'Piloti oder BauKI?',
      lede: 'BauKI ist ein günstiges Werkzeug zum Selbstanmelden, gebaut für Bauvorschriften in Deutschland. Piloti ist für österreichische Projekte gebaut und noch in der Pilotphase. Hier der Vergleich, auch dort, wo BauKI vorn liegt.',
      note: 'Gemeint ist BauKI (bauki.eu) der Plandirekt24 UG aus Mölln, Deutschland. Angaben zu BauKI laut bauki.eu.',
      answer:
        'Suchen Sie ein günstiges Werkzeug mit Monatsabo, Servern in Deutschland und Paragrafen aus deutschen Baugesetzen, passt BauKI. Planen Sie in Österreich und brauchen Landesbauordnung, OIB-Richtlinien und ein Projekt, in dem Aufgaben und Freigaben laufen, passt Piloti.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'BauKI',
          rows: [
            { label: 'Markt', a: 'Österreich', b: 'Deutschland; „Bundesland wählen“ bezieht sich auf deutsche Länder' },
            {
              label: 'Regelwerke',
              a: 'Die neun Landesbauordnungen und weiteres Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze',
              b: '„125+ Baugesetze, KfW- und BAFA-Programme“, Beispiele aus dem deutschen Recht wie BauGB; Österreich und OIB-Richtlinien nicht als abgedeckt genannt',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis auf Paragraf oder Punkt, vor dem Anzeigen gegen den Quelltext geprüft',
              b: '„Jede Antwort belegt mit §-Quelle aus dem Gesetz“; Gesetzesbibliothek mit PDF-Ansicht und Paragrafensuche',
            },
            {
              label: 'Eigene Unterlagen',
              a: 'Büroarchiv und Projektdokumente als Quellen; Upload von PDF, Word, Excel, PowerPoint, CSV, Bildern und Ordnern',
              b: 'Hochgeladene Dateien als dauerhafte Wissensdatenbank; Synchronisation mit Google Drive',
            },
            {
              label: 'Ausgabe',
              a: 'Aktenvermerk, Protokoll, Checkliste; Bericht der Tiefenrecherche als PDF oder Word; Freigabe im Büro',
              b: 'Word, PDF und Excel, darunter ein „Prüfbericht mit Logo … und Unterschriftsfeld“',
            },
            {
              label: 'Modelle',
              a: 'IFC-Vorschau und Modellbereich; Pläne und Fotos werden als Bild angesehen',
              b: 'IFC-Viewer',
            },
            {
              label: 'Projektarbeit',
              a: 'Projekte mit Fassungen, Freigabe, Aufgaben, wiederkehrenden Prüfungen und Projektgedächtnis',
              b: 'Projekte bündeln Chats, Dokumente und Notizen',
            },
            {
              label: 'Hosting',
              a: 'Anmeldung über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, auch außerhalb der EU',
              b: 'Server ausschließlich in Deutschland',
            },
            {
              label: 'Preis',
              a: 'Noch keine Preisliste; Bedingungen je Pilotbüro',
              b: '23,00 € oder 49,00 € im Monat zzgl. MwSt., monatlich kündbar, 5 Tage kostenlos',
            },
          ],
          note: 'Angaben zu BauKI laut bauki.eu, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo BauKI vorn liegt',
            items: [
              'Der Preis. Ab 23 € im Monat, monatlich kündbar; Piloti hat noch gar keine Preisliste.',
              'Selbst anmelden und 5 Tage testen. Bei Piloti beginnt es mit einem Gespräch.',
              'Server in Deutschland. Diesen Standort sagt Piloti heute nicht zu.',
              'Google-Drive-Anbindung und ein fertiger Prüfbericht mit Logo und Unterschriftsfeld.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Landesrecht aus dem RIS und die OIB-Richtlinien in der Ausgabe, die im Bundesland gilt.',
              'Prüfungen nach Gebäudeklasse als Tabelle, mit Quelle und Ergebnis je Zeile, und Pläne, die als Bild gelesen werden.',
              'Arbeit statt Chat: Aufgaben bis Freitag, wiederkehrende Prüfungen, Befunde als offene Punkte, Freigabe im Büro, bevor ein Dokument als Quelle gilt.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Günstig und sofort, aber für welches Land?',
          body: [
            'BauKI bietet viel für den Preis: Gesetzesbibliothek, Paragrafenbelege, eine eigene Wissensdatenbank, IFC-Viewer und Berichte zum Unterschreiben. Wer in Deutschland plant und schnell loslegen will, bekommt das ohne Verkaufsgespräch.',
            'Für ein Projekt in Salzburg oder Linz entscheidet aber zuerst, welches Recht gilt. Die Auswahl „Bundesland“ meint bei BauKI deutsche Länder. Ein Paragraf aus dem BauGB hilft bei einer Einreichung in Österreich nicht, und die OIB-Richtlinien stehen auf bauki.eu nicht unter den abgedeckten Quellen. Piloti zitiert die Landesbauordnung so, wie ein Bescheid sie nennt, und öffnet die RIS-Stelle direkt im Werkzeug.',
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti aufhört',
          items: [
            'Kein deutsches Baurecht und keine Förderprogramme wie KfW oder BAFA.',
            'Keine ÖNORM-Texte, nur ein Verzeichnis der relevanten Normen.',
            'Keine Anbindung an Google Drive; Unterlagen werden hochgeladen.',
            'Kein Selbsttest und keine Preisliste: Piloti läuft als Proof of Concept mit ausgewählten Pilotbüros.',
          ],
        },
      ],
      faq: [
        {
          q: 'Funktioniert BauKI für Österreich?',
          a: 'bauki.eu nennt deutsche Baugesetze wie das BauGB sowie KfW- und BAFA-Programme; Österreich und die OIB-Richtlinien sind nicht als abgedeckt aufgeführt (Stand September 2026). Für Projekte in Österreich ist Piloti gebaut, mit den neun Landesbauordnungen aus dem RIS.',
        },
        {
          q: 'Was kostet BauKI?',
          a: 'BauKI nennt 23,00 € und 49,00 € im Monat zuzüglich Mehrwertsteuer, monatlich kündbar, und 5 Tage kostenlos. Piloti hat noch keine Preisliste; in der Pilotphase werden die Bedingungen mit jedem Büro einzeln vereinbart.',
        },
        {
          q: 'Kann Piloti einen Prüfbericht erstellen?',
          a: 'Piloti schreibt Aktenvermerke, Protokolle und Checklisten und legt den Bericht einer Tiefenrecherche mit Urteil und Befundmatrix im Projekt ab, als PDF oder Word. Ein Dokument von Piloti wird erst zur zitierbaren Quelle, wenn das Büro es freigibt und veröffentlicht.',
        },
        {
          q: 'Wo liegen die Daten?',
          a: 'BauKI gibt Server ausschließlich in Deutschland an. Bei Piloti läuft die Anmeldung über WorkOS (USA), KI-Anfragen gehen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können. Mit Büro-Daten werden keine Modelle trainiert, und Pläne bleiben Eigentum des Büros.',
        },
      ],
    },
    en: {
      title: 'BauKI alternative for Austria: Piloti compared',
      description:
        'Piloti or BauKI? Regulations, evidence, knowledge base, inspection report, hosting and prices compared, including where BauKI is ahead – for Austria.',
      heading: 'Piloti or BauKI?',
      lede: 'BauKI is an affordable self-serve tool built for building regulations in Germany. Piloti is built for Austrian projects and still in its pilot phase. Here is the comparison, including where BauKI is ahead.',
      note: 'This means BauKI (bauki.eu) by Plandirekt24 UG from Mölln, Germany. BauKI details as stated on bauki.eu.',
      answer:
        'If you want an affordable tool on a monthly plan, with servers in Germany and sections from German building laws, BauKI fits. If you plan in Austria and need the state building code, the OIB guidelines and a project where tasks and approvals run, Piloti fits.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'BauKI',
          rows: [
            { label: 'Market', a: 'Austria', b: 'Germany; “choose a state” refers to German states' },
            {
              label: 'Regulations',
              a: 'The nine state building codes and further state law from RIS, OIB guidelines, register of standards, federal law',
              b: '“125+ building laws, KfW and BAFA programmes”, examples from German law such as BauGB; Austria and the OIB guidelines not listed as covered',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section or clause, checked against the source text before it is shown',
              b: '“Every answer backed by a § source from the law”; law library with PDF viewer and section search',
            },
            {
              label: 'Own documents',
              a: 'Office archive and project documents as sources; upload of PDF, Word, Excel, PowerPoint, CSV, images and folders',
              b: 'Uploaded files as a permanent knowledge base; Google Drive sync',
            },
            {
              label: 'Output',
              a: 'File note, minutes, checklist; in-depth research report as PDF or Word; approval in the office',
              b: 'Word, PDF and Excel, including an “inspection report with logo … and signature field”',
            },
            {
              label: 'Models',
              a: 'IFC preview and model area; drawings and photos are looked at as images',
              b: 'IFC viewer',
            },
            {
              label: 'Project work',
              a: 'Projects with versions, approval, tasks, recurring checks and project memory',
              b: 'Projects bundle chats, documents and notes',
            },
            {
              label: 'Hosting',
              a: 'Sign-in through WorkOS (USA), AI requests through OpenRouter (USA) to model providers, some outside the EU',
              b: 'Servers only in Germany',
            },
            {
              label: 'Price',
              a: 'No price list yet; terms agreed with each pilot office',
              b: '€23.00 or €49.00 per month plus VAT, cancellable monthly, 5 days free',
            },
          ],
          note: 'BauKI details as stated on bauki.eu, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where BauKI is ahead',
            items: [
              'Price. From €23 a month, cancellable monthly; Piloti has no price list at all yet.',
              'Sign up yourself and test for 5 days. With Piloti it starts with a conversation.',
              'Servers in Germany. Piloti makes no such location promise today.',
              'Google Drive sync and a ready-made inspection report with logo and signature field.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian state law from RIS and the OIB guidelines in the edition that applies in the state.',
              'Checks by building class as tables, with source and result per row, and drawings read as images.',
              'Work, not just chat: tasks due Friday, recurring checks, findings as open points, office approval before a document counts as a source.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Affordable and immediate, but for which country?',
          body: [
            'BauKI offers a lot for the price: a law library, section references, a knowledge base of your own, an IFC viewer and reports ready to sign. If you plan in Germany and want to start right away, you get that without a sales call.',
            'For a project in Salzburg or Linz, though, the first question is which law applies. BauKI’s “state” selection means German states. A section of the BauGB does not help with a submission in Austria, and the OIB guidelines are not listed among the covered sources on bauki.eu. Piloti cites the state building code the way an official decision cites it and opens the RIS passage inside the tool.',
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops',
          items: [
            'No German building law and no funding programmes such as KfW or BAFA.',
            'No ÖNORM texts, only a register of the relevant standards.',
            'No Google Drive connection; documents are uploaded.',
            'No self-serve trial and no price list: Piloti runs as a proof of concept with selected pilot offices.',
          ],
        },
      ],
      faq: [
        {
          q: 'Does BauKI work for Austria?',
          a: 'bauki.eu names German building laws such as the BauGB, plus KfW and BAFA programmes; Austria and the OIB guidelines are not listed as covered (as of September 2026). Piloti is built for projects in Austria, with the nine state building codes from RIS.',
        },
        {
          q: 'What does BauKI cost?',
          a: 'BauKI lists €23.00 and €49.00 per month plus VAT, cancellable monthly, and 5 days free. Piloti has no price list yet; during the pilot phase, terms are agreed with each office individually.',
        },
        {
          q: 'Can Piloti produce an inspection report?',
          a: 'Piloti writes file notes, minutes and checklists and files an in-depth research report with verdict and findings matrix in the project, as PDF or Word. A document written by Piloti only becomes a citable source once the office approves and publishes it.',
        },
        {
          q: 'Where is the data?',
          a: 'BauKI states servers only in Germany. With Piloti, sign-in runs through WorkOS (USA) and AI requests go through OpenRouter (USA) to model providers that may be based outside the EU. No models are trained on office data, and drawings remain the office’s property.',
        },
      ],
    },
  },
  {
    slug: 'k24ai',
    checked: '2026-09',
    related: ['vergleich/bauki', 'vergleich/reiner-ai', 'baurecht/tirol', 'anwendungen/brandschutz', 'anwendungen/gebaeudeklasse'],
    de: {
      title: 'K24AI Alternative: Piloti im Vergleich für Österreich',
      description:
        'Piloti oder K24AI? Beide nennen OIB-Richtlinien und Bürodokumente. Quellen, Belege, Projektarbeit, Hosting und Verfügbarkeit im Vergleich, mit Datum.',
      heading: 'Piloti oder K24AI?',
      lede: 'Von allen Werkzeugen in diesen Vergleichen ist K24AI Piloti im Ansatz am nächsten: OIB-Richtlinien, Normen und eigene Bürounterlagen, mit zitierten Antworten. Hier, worin sie sich unterscheiden, und wo K24AI vorn liegt.',
      note: 'Gemeint ist K24AI (k24ai.com). Angaben zu K24AI laut k24ai.com, einschließlich des dortigen Hinweises vom Juli 2026.',
      answer:
        'K24AI und Piloti setzen ähnlich an: OIB-Richtlinien, Normen und Bürodokumente, mit Belegen. Der Unterschied heute ist die Verfügbarkeit: K24AI hat laut eigener Website den Alpha-Start verschoben und nimmt keine neuen Tester auf, Piloti läuft mit ausgewählten Pilotbüros und arbeitet mit den Landesbauordnungen aus dem RIS im Projekt.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'K24AI',
          rows: [
            {
              label: 'Markt',
              a: 'Planungsbüros in Österreich',
              b: 'Architekten, Ingenieure und Planer im DACH-Raum',
            },
            {
              label: 'Quellen',
              a: 'Die neun Landesbauordnungen und weiteres Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze, Büroarchiv, Projektdokumente',
              b: 'OIB-Richtlinien, DIN-Normen und Bürodokumente; Rechtsquellen aus Österreich, Deutschland, der Schweiz und dem europäischen Recht',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis auf Paragraf oder Punkt, vor dem Anzeigen gegen den Quelltext geprüft; RIS-Stellen öffnen im Werkzeug',
              b: 'Anklickbare Zitate mit Hinweis auf die Fassung',
            },
            {
              label: 'Werkzeuge',
              a: 'Arbeitsweisen für Gebäudeklasse, Brandschutz, Einreichcheck, Bestand, Bebauung, Wärmeschutz, Barrierefreiheit, Aufenthaltsraum; eigene lassen sich ergänzen',
              b: 'Wissensgraph, Mindmap, Compliance-Check, Agenten wie Brandschutz-Check, Normen-Vergleich und Konflikt-Scanner',
            },
            {
              label: 'Sichtbarkeit',
              a: 'Büroarchiv, das kein anderes Büro sieht; Projekte mit Dateien und Fassungen',
              b: 'Vier Stufen: global, Organisation, Projekt, privat',
            },
            {
              label: 'Projektarbeit',
              a: 'Aufgaben unter Ihrem Namen, wiederkehrende Prüfungen, Tiefenrecherche mit Bericht, Freigabe im Posteingang',
              b: 'Projektebene als Sichtbarkeitsstufe; Aufgaben und Freigaben auf der Website nicht beschrieben',
            },
            {
              label: 'Hosting',
              a: 'Anmeldung über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, auch außerhalb der EU',
              b: 'Hosting in Frankfurt, Datenhaltung in Europa; „Kein Training mit Ihren Dokumenten“',
            },
            { label: 'Preis', a: 'Noch keine Preisliste; Bedingungen je Pilotbüro', b: 'Preise noch nicht festgelegt' },
            {
              label: 'Stand',
              a: 'Proof of Concept, in Betrieb mit ausgewählten Pilotbüros',
              b: 'Laut Website (Juli 2026): Alpha-Start verschoben, Wissensbasis im Neuaufbau, keine neuen Tester',
            },
          ],
          note: 'Angaben zu K24AI laut k24ai.com, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo K24AI vorn liegt',
            items: [
              'Mehr Länder. K24AI nennt Rechtsquellen aus Österreich, Deutschland, der Schweiz und dem europäischen Recht; Piloti bleibt bei Österreich.',
              'DIN-Normen als Quelle. Piloti führt nur ein Verzeichnis der relevanten Normen, keine Normtexte.',
              'Ein Hosting-Standort in Frankfurt mit Datenhaltung in Europa. Piloti sagt keinen Datenstandort zu.',
              'Vier Sichtbarkeitsstufen und Werkzeuge wie Wissensgraph, Mindmap und Konflikt-Scanner.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Heute in Betrieb. Pilotbüros stellen echte Projektfragen, und neue Büros können mit einer echten Frage testen.',
              'Die Landesbauordnungen aus dem RIS, zitiert, wie ein Bescheid sie nennt, mit der OIB-Ausgabe, die im Bundesland gilt.',
              'Das Projekt als Arbeitsort: Aufgaben, Tiefenrecherche mit Bericht, offene Punkte und Freigabe, bevor ein Dokument als Quelle gilt.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Ähnlicher Ansatz, anderer Stand',
          body: [
            'K24AI beschreibt, was viele Büros in Österreich suchen: OIB-Richtlinien und Bürodokumente an einem Ort, Antworten mit Zitat, Konflikte zwischen Regeln sichtbar gemacht. Das ist nah an dem, woran auch Piloti arbeitet, und wir halten den Ansatz für richtig.',
            'Der Unterschied liegt heute weniger im Konzept als im Stand. Laut Hinweis auf k24ai.com vom Juli 2026 ist der Alpha-Start verschoben, die Wissensbasis wird neu aufgebaut, und neue Tester werden vorerst nicht aufgenommen. Piloti ist ebenfalls kein fertiges Produkt, läuft aber als Proof of Concept mit Pilotbüros. Dazu kommt ein Schwerpunkt: Piloti arbeitet mit dem Landesrecht aus dem RIS und bringt Aufgaben, Berichte und Freigaben ins Projekt.',
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti aufhört',
          items: [
            'Nur Österreich: kein deutsches oder Schweizer Baurecht.',
            'Keine Normtexte, weder ÖNORM noch DIN, nur ein Verzeichnis der relevanten Normen.',
            'Keine Zusage zum Datenstandort.',
            'Auch Piloti ist nicht frei zugänglich: Pilotphase mit ausgewählten Büros, keine Preisliste.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann ich K24AI derzeit nutzen?',
          a: 'Laut Hinweis auf k24ai.com vom Juli 2026 ist der Alpha-Start verschoben, die Wissensbasis wird neu aufgebaut, und neue Tester werden vorerst nicht aufgenommen. Wie es weitergeht, sagt am verlässlichsten die Website selbst.',
        },
        {
          q: 'Worin unterscheiden sich K24AI und Piloti?',
          a: 'Beide arbeiten mit OIB-Richtlinien und Bürodokumenten und zitieren ihre Quellen. K24AI nennt dazu DIN-Normen und Rechtsquellen aus Deutschland und der Schweiz. Piloti bleibt bei Österreich, arbeitet mit den neun Landesbauordnungen aus dem RIS und bringt Aufgaben, Berichte und Freigaben ins Projekt.',
        },
        {
          q: 'Was kostet K24AI?',
          a: 'K24AI gibt an, dass die Preise noch nicht festgelegt sind (Stand September 2026). Auch Piloti hat noch keine Preisliste; in der Pilotphase werden die Bedingungen mit jedem Büro einzeln vereinbart.',
        },
        {
          q: 'Wo werden die Daten verarbeitet?',
          a: 'K24AI nennt Hosting in Frankfurt mit Datenhaltung in Europa und kein Training mit Ihren Dokumenten. Bei Piloti läuft die Anmeldung über WorkOS (USA), KI-Anfragen gehen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können. Auch Piloti trainiert keine Modelle mit Büro-Daten.',
        },
      ],
    },
    en: {
      title: 'K24AI alternative: Piloti compared for Austria',
      description:
        'Piloti or K24AI? Both name the OIB guidelines and office documents. Sources, evidence, project work, hosting and availability compared, with a date.',
      heading: 'Piloti or K24AI?',
      lede: 'Of all the tools in these comparisons, K24AI is closest to Piloti in approach: OIB guidelines, standards and your own office documents, with cited answers. Here is how they differ, and where K24AI is ahead.',
      note: 'This means K24AI (k24ai.com). K24AI details as stated on k24ai.com, including its notice of July 2026.',
      answer:
        'K24AI and Piloti take a similar approach: OIB guidelines, standards and office documents, with evidence. The difference today is availability: according to its website, K24AI has postponed its alpha start and is not taking new testers, while Piloti runs with selected pilot offices and works with the state building codes from RIS inside the project.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'K24AI',
          rows: [
            {
              label: 'Market',
              a: 'Planning offices in Austria',
              b: 'Architects, engineers and planners in the DACH region',
            },
            {
              label: 'Sources',
              a: 'The nine state building codes and further state law from RIS, OIB guidelines, register of standards, federal law, office archive, project documents',
              b: 'OIB guidelines, DIN standards and office documents; legal sources from Austria, Germany, Switzerland and European law',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section or clause, checked against the source text before it is shown; RIS passages open inside the tool',
              b: 'Clickable citations with a note on the version',
            },
            {
              label: 'Tools',
              a: 'Ways of working for building class, fire safety, submission check, existing buildings, plot rules, thermal protection, accessibility, habitable rooms; offices can add their own',
              b: 'Knowledge graph, mind map, compliance check, agents such as fire safety check, standards comparison and conflict scanner',
            },
            {
              label: 'Visibility',
              a: 'Office archive that no other office sees; projects with files and versions',
              b: 'Four levels: global, organisation, project, private',
            },
            {
              label: 'Project work',
              a: 'Tasks under your name, recurring checks, in-depth research with report, approval in the inbox',
              b: 'Project as a visibility level; tasks and approvals not described on the website',
            },
            {
              label: 'Hosting',
              a: 'Sign-in through WorkOS (USA), AI requests through OpenRouter (USA) to model providers, some outside the EU',
              b: 'Hosting in Frankfurt, data kept in Europe; “no training on your documents”',
            },
            { label: 'Price', a: 'No price list yet; terms agreed with each pilot office', b: 'Prices not yet set' },
            {
              label: 'Stage',
              a: 'Proof of concept, running with selected pilot offices',
              b: 'According to its website (July 2026): alpha start postponed, knowledge base being rebuilt, no new testers',
            },
          ],
          note: 'K24AI details as stated on k24ai.com, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where K24AI is ahead',
            items: [
              'More countries. K24AI names legal sources from Austria, Germany, Switzerland and European law; Piloti stays with Austria.',
              'DIN standards as a source. Piloti keeps only a register of the relevant standards, not their texts.',
              'A hosting location in Frankfurt with data kept in Europe. Piloti makes no data-location promise.',
              'Four visibility levels and tools such as a knowledge graph, mind map and conflict scanner.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'Running today. Pilot offices ask real project questions, and new offices can test with a real question.',
              'The state building codes from RIS, cited the way an official decision cites them, with the OIB edition that applies in the state.',
              'The project as the place of work: tasks, in-depth research with a report, open points and approval before a document counts as a source.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Similar approach, different stage',
          body: [
            'K24AI describes what many offices in Austria are looking for: OIB guidelines and office documents in one place, answers with citations, conflicts between rules made visible. That is close to what Piloti works on too, and we think the approach is right.',
            'Today the difference lies less in the concept than in the stage. According to a notice on k24ai.com from July 2026, the alpha start is postponed, the knowledge base is being rebuilt and new testers are not being taken on for now. Piloti is not a finished product either, but it runs as a proof of concept with pilot offices. There is also a difference in focus: Piloti works with state law from RIS and brings tasks, reports and approvals into the project.',
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops',
          items: [
            'Austria only: no German or Swiss building law.',
            'No standards texts, neither ÖNORM nor DIN, only a register of the relevant standards.',
            'No promise on data location.',
            'Piloti is not openly available either: pilot phase with selected offices, no price list.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can I use K24AI right now?',
          a: 'According to a notice on k24ai.com from July 2026, the alpha start is postponed, the knowledge base is being rebuilt and new testers are not being taken on for now. The website itself is the most reliable place to see what happens next.',
        },
        {
          q: 'How do K24AI and Piloti differ?',
          a: 'Both work with the OIB guidelines and office documents and cite their sources. K24AI also names DIN standards and legal sources from Germany and Switzerland. Piloti stays with Austria, works with the nine state building codes from RIS and brings tasks, reports and approvals into the project.',
        },
        {
          q: 'What does K24AI cost?',
          a: 'K24AI states that prices have not yet been set (as of September 2026). Piloti has no price list yet either; during the pilot phase, terms are agreed with each office individually.',
        },
        {
          q: 'Where is the data processed?',
          a: 'K24AI names hosting in Frankfurt with data kept in Europe and no training on your documents. With Piloti, sign-in runs through WorkOS (USA) and AI requests go through OpenRouter (USA) to model providers that may be based outside the EU. Piloti does not train models on office data either.',
        },
      ],
    },
  },
  {
    slug: 'baurechtgpt',
    checked: '2026-09',
    related: ['vergleich/weka-bau-ai', 'vergleich/chatgpt', 'baurecht/wien', 'anwendungen/einreichcheck'],
    de: {
      title: 'BaurechtGPT für Österreich? Piloti im Vergleich',
      description:
        'BaurechtGPT vom Forum Verlag oder Piloti? Rechtsgrundlage, Belege, Hosting und Preis im Vergleich – und warum der Name nicht Österreich meint.',
      heading: 'BaurechtGPT oder Piloti für österreichisches Baurecht?',
      lede: 'BaurechtGPT ist ein KI-Chatbot für baurechtliche Fragen der Forum Verlag Herkert GmbH, einem Fachverlag aus Deutschland. Er antwortet aus deutschem Recht. Hier der Vergleich, auch dort, wo BaurechtGPT vorn liegt.',
      note: 'Gemeint ist BaurechtGPT (gpt.forum-verlag.com) der Forum Verlag Herkert GmbH, Deutschland. Angaben laut Forum Verlag, auf gpt.forum-verlag.com und im Forum-Verlag-Shop.',
      answer:
        'BaurechtGPT beantwortet Fragen zum deutschen Baurecht, laut Forum Verlag auf Basis von BauGB, BGB, VOB und den Landesbauordnungen deutscher Länder. Für ein Projekt in Österreich, dessen Fragen an Landesbauordnung und OIB-Richtlinien hängen, ist Piloti gebaut.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'BaurechtGPT',
          rows: [
            { label: 'Anbieter', a: 'Piloti aus Wien, Unternehmen in Gründung', b: 'Forum Verlag Herkert GmbH, Fachverlag aus Deutschland' },
            {
              label: 'Rechtsgrundlage',
              a: 'Die neun Landesbauordnungen und weiteres Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze',
              b: 'Laut Forum Verlag BauGB, BGB, VOB und die Landesbauordnungen; Österreich und OIB-Richtlinien nicht als Grundlage genannt',
            },
            {
              label: 'Datenbasis',
              a: 'Gesetzestext und Richtlinie, dazu Ihr Büroarchiv, die Projektdokumente und Webrecherche mit verlinkter Quelle',
              b: 'Laut Forum Verlag eine „von Fachjuristen kuratierte Datenbank“, laufend aktualisiert; das Modell baut auf GPT-4 auf',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis auf Paragraf oder Punkt, vor dem Anzeigen gegen den Quelltext geprüft',
              b: '„Die Antworten sind referenziert und liefern automatisch auch die verwendeten Quellen mit.“',
            },
            {
              label: 'Eigene Unterlagen',
              a: 'Büroarchiv und Projektdokumente als Quellen; Pläne werden als Bild angesehen',
              b: 'Auf den gelesenen Seiten nicht genannt',
            },
            {
              label: 'Arbeit im Team',
              a: 'Projekte mit Aufgaben, Fassungen, Freigabe und Projektgedächtnis',
              b: 'Mehrbenutzerfähig, mit integrierter Benutzerverwaltung',
            },
            {
              label: 'Hosting',
              a: 'Anmeldung über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, auch außerhalb der EU',
              b: 'Server in Deutschland; für die KI-Verarbeitung internationale API-Anbieter, eine Verarbeitung außerhalb der EU „nicht vollständig ausgeschlossen“',
            },
            {
              label: 'Preis',
              a: 'Noch keine Preisliste; Bedingungen je Pilotbüro',
              b: '39 € im Monat oder 390 € im Jahr, jeweils zzgl. MwSt.; im Shop als Jahresbezug mit 75 Prompts pro Monat; kein Testzeitraum genannt',
            },
          ],
          note: 'Angaben zu BaurechtGPT laut Forum Verlag, auf gpt.forum-verlag.com/baurecht und shop.forum-verlag.com, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo BaurechtGPT vorn liegt',
            items: [
              'Eine Datenbasis, die Fachjurist:innen eines Verlags kuratieren. Piloti hat keine juristische Redaktion.',
              'Deutsches Bauvertragsrecht, Gewährleistung und Haftung nach BGB und VOB. Das deckt Piloti nicht ab.',
              'Ein offener Preis und sofortiger Zugang nach Bestellung. Bei Piloti beginnt es mit einem Gespräch.',
              'Server in Deutschland für Anwendungs- und Nutzungsdaten.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Landesrecht aus dem RIS und die OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt.',
              'Ihre Pläne und Unterlagen: Büroarchiv und Projektdokumente sind Quellen, Grundriss und Schnitt werden als Bild gelesen.',
              'Mehr als Antworten: Einreichcheck, Tiefenrecherche mit Bericht, Aktenvermerke zur Freigabe.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Der Name sagt „Baurecht“, gemeint ist deutsches',
          body: [
            'Wer in Österreich nach „BaurechtGPT“ sucht, erwartet leicht ein Werkzeug für das eigene Baurecht. Laut Forum Verlag beruhen die Antworten aber auf BauGB, BGB, VOB und den Landesbauordnungen; gemeint sind deutsche Gesetze. Österreich taucht auf den Seiten nur als Rechnungsland auf.',
            'Für österreichische Projekte ist das mehr als ein Detail. Die Bauordnung für Wien, die NÖ Bauordnung 2014 oder die Tiroler Bauordnung 2022 regeln andere Dinge als eine deutsche Landesbauordnung, und die technischen Anforderungen stehen in den OIB-Richtlinien in der Ausgabe, die das jeweilige Land für verbindlich erklärt hat. Eine Antwort, die das nicht unterscheidet, hilft bei der Einreichung nicht.',
          ],
        },
        {
          kind: 'list',
          title: 'Wo Piloti aufhört',
          items: [
            'Kein deutsches Recht und kein Vertragsrecht als eigene Quelle.',
            'Keine ÖNORM-Texte, nur ein Verzeichnis der relevanten Normen.',
            'Keine Rechtsberatung: Piloti liefert eine belegte Arbeitsgrundlage, die Entscheidung trifft das Büro.',
            'Keine Zusage zum Datenstandort, keine Preisliste, Pilotphase mit ausgewählten Büros.',
          ],
        },
      ],
      faq: [
        {
          q: 'Gilt BaurechtGPT für österreichisches Baurecht?',
          a: 'Laut Forum Verlag beruhen die Antworten auf BauGB, BGB, VOB und den Landesbauordnungen, also auf deutschem Recht. Österreichisches Landesrecht und die OIB-Richtlinien werden auf den gelesenen Seiten nicht genannt (Stand September 2026). Für Projekte in Österreich ist Piloti gebaut.',
        },
        {
          q: 'Wer steht hinter BaurechtGPT?',
          a: 'Die Forum Verlag Herkert GmbH, laut eigener Angabe einer der führenden Fachverlage Deutschlands und seit über 35 Jahren in der Fachinformation tätig. Das Modell baut laut Verlag auf der GPT-4-Architektur auf.',
        },
        {
          q: 'Was kostet BaurechtGPT?',
          a: 'Auf gpt.forum-verlag.com nennt der Verlag 39 € im Monat oder 390 € im Jahr, jeweils zuzüglich Mehrwertsteuer. Im Shop wird es als Jahresbezug mit 75 Prompts pro Monat angeboten. Piloti hat noch keine Preisliste; die Bedingungen werden in der Pilotphase je Büro vereinbart.',
        },
        {
          q: 'Wo werden die Daten verarbeitet?',
          a: 'Der Forum Verlag betreibt die Anwendung auf Servern in Deutschland und nutzt für die KI internationale API-Anbieter; eine Verarbeitung außerhalb der EU sei nicht vollständig ausgeschlossen. Bei Piloti gehen KI-Anfragen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können. Beide trainieren laut eigener Angabe keine Modelle mit Kundendaten.',
        },
      ],
    },
    en: {
      title: 'BaurechtGPT for Austria? Piloti compared',
      description:
        'BaurechtGPT by Forum Verlag or Piloti? Legal basis, evidence, own documents, hosting and price compared – and why the name does not mean Austrian law.',
      heading: 'BaurechtGPT or Piloti for Austrian building law?',
      lede: 'BaurechtGPT is an AI chatbot for building-law questions by Forum Verlag Herkert GmbH, a specialist publisher from Germany. It answers from German law. Here is the comparison, including where BaurechtGPT is ahead.',
      note: 'This means BaurechtGPT (gpt.forum-verlag.com) by Forum Verlag Herkert GmbH, Germany. Details as stated by Forum Verlag on gpt.forum-verlag.com and in the Forum Verlag shop.',
      answer:
        'BaurechtGPT answers questions on German building law, according to Forum Verlag on the basis of BauGB, BGB, VOB and the building codes of German states. Piloti is built for a project in Austria whose questions hinge on the state building code and the OIB guidelines.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'BaurechtGPT',
          rows: [
            { label: 'Vendor', a: 'Piloti from Vienna, company in formation', b: 'Forum Verlag Herkert GmbH, specialist publisher from Germany' },
            {
              label: 'Legal basis',
              a: 'The nine state building codes and further state law from RIS, OIB guidelines, register of standards, federal law',
              b: 'According to Forum Verlag BauGB, BGB, VOB and the state building codes; Austria and the OIB guidelines not named as a basis',
            },
            {
              label: 'Data',
              a: 'Legal text and guideline, plus your office archive, the project documents and web research with linked sources',
              b: 'According to Forum Verlag a “database curated by legal experts”, updated continuously; the model builds on GPT-4',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section or clause, checked against the source text before it is shown',
              b: '“The answers are referenced and automatically include the sources used.”',
            },
            {
              label: 'Own documents',
              a: 'Office archive and project documents as sources; drawings are looked at as images',
              b: 'Not mentioned on the pages we read',
            },
            {
              label: 'Teamwork',
              a: 'Projects with tasks, versions, approval and project memory',
              b: 'Multi-user, with built-in user management',
            },
            {
              label: 'Hosting',
              a: 'Sign-in through WorkOS (USA), AI requests through OpenRouter (USA) to model providers, some outside the EU',
              b: 'Servers in Germany; international API providers for AI processing, processing outside the EU “cannot be fully ruled out”',
            },
            {
              label: 'Price',
              a: 'No price list yet; terms agreed with each pilot office',
              b: '€39 per month or €390 per year, plus VAT; in the shop as an annual subscription with 75 prompts per month; no trial mentioned',
            },
          ],
          note: 'BaurechtGPT details as stated by Forum Verlag on gpt.forum-verlag.com/baurecht and shop.forum-verlag.com, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where BaurechtGPT is ahead',
            items: [
              'A database curated by a publisher’s legal experts. Piloti has no legal editorial team.',
              'German construction contract law, warranty and liability under BGB and VOB. Piloti does not cover these.',
              'A public price and immediate access after ordering. With Piloti it starts with a conversation.',
              'Servers in Germany for application and usage data.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian state law from RIS and the OIB guidelines, cited the way an official decision cites them.',
              'Your drawings and documents: the office archive and project documents are sources, plan and section are read as images.',
              'More than answers: submission check, in-depth research with a report, file notes sent for approval.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'The name says “building law”, but it means German law',
          body: [
            'Anyone in Austria searching for “BaurechtGPT” may well expect a tool for their own building law. According to Forum Verlag, though, the answers rest on BauGB, BGB, VOB and the state building codes; these are German laws. Austria appears on its pages only as a billing country.',
            'For Austrian projects this is more than a detail. The Vienna Building Code, the Lower Austrian Building Code 2014 or the Tyrolean Building Code 2022 govern different things from a German state building code, and the technical requirements sit in the OIB guidelines, in the edition each state has declared binding. An answer that does not tell these apart does not help with a submission.',
          ],
        },
        {
          kind: 'list',
          title: 'Where Piloti stops',
          items: [
            'No German law and no contract law as a source of its own.',
            'No ÖNORM texts, only a register of the relevant standards.',
            'No legal advice: Piloti delivers a documented working basis, and the office makes the decision.',
            'No promise on data location, no price list, pilot phase with selected offices.',
          ],
        },
      ],
      faq: [
        {
          q: 'Does BaurechtGPT cover Austrian building law?',
          a: 'According to Forum Verlag, the answers rest on BauGB, BGB, VOB and the state building codes, which is German law. Austrian state law and the OIB guidelines are not named on the pages we read (as of September 2026). Piloti is built for projects in Austria.',
        },
        {
          q: 'Who is behind BaurechtGPT?',
          a: 'Forum Verlag Herkert GmbH, by its own account one of Germany’s leading specialist publishers, with over 35 years in professional information. According to the publisher, the model builds on the GPT-4 architecture.',
        },
        {
          q: 'What does BaurechtGPT cost?',
          a: 'On gpt.forum-verlag.com the publisher lists €39 per month or €390 per year, plus VAT. In its shop it is offered as an annual subscription with 75 prompts per month. Piloti has no price list yet; during the pilot phase, terms are agreed with each office.',
        },
        {
          q: 'Where is the data processed?',
          a: 'Forum Verlag runs the application on servers in Germany and uses international API providers for the AI; it says processing outside the EU cannot be fully ruled out. With Piloti, AI requests go through OpenRouter (USA) to model providers that may be based outside the EU. Both say they do not train models on customer data.',
        },
      ],
    },
  },
]
