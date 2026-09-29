/**
 * Piloti next to AI tools built for construction and planning. Each page
 * argues for Piloti first; the other tool's column says only what that
 * vendor's own site says, read in the month `checked` names.
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
        'Piloti oder Reiner AI (oft „Rainer AI“ gesucht)? Landesbauordnungen, OIB-Richtlinien, Belege, Pläne und Projektarbeit im Vergleich für Büros in Österreich.',
      heading: 'Piloti oder Reiner AI?',
      lede: 'Piloti ist für Planungsbüros in Österreich gebaut: Es liest Landesbauordnung, OIB-Richtlinien und Ihre Pläne und belegt jede Antwort mit der Fundstelle. Reiner AI ist ein KI-Werkzeug für Bau- und Vertragsdokumente in Deutschland. Hier der Vergleich.',
      note: 'Gemeint ist Reiner AI (reiner.ai) aus Deutschland, oft auch als „Rainer AI“ gesucht. Angaben zu Reiner AI laut reiner.ai.',
      answer:
        'Für Planungsfragen in Österreich ist Piloti die bessere Wahl: Es arbeitet mit den neun Landesbauordnungen aus dem RIS und den OIB-Richtlinien, prüft jede Fundstelle vor dem Anzeigen und bringt Aufgaben, Berichte und Freigaben ins Projekt. Reiner AI ist auf deutsche Bauverträge und HOAI ausgerichtet.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Baurecht als Grundlage: die neun Landesbauordnungen aus dem RIS und die OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt.',
              'Das Bundesland zählt. Piloti nennt die OIB-Ausgabe, die im Land Ihres Projekts gilt, und öffnet die RIS-Stelle direkt im Werkzeug.',
              'Belege, die halten: Jede Fundstelle wird vor dem Anzeigen gegen den Quelltext geprüft, bis auf Paragraf, Punkt oder Seite.',
              'Das Projekt als Arbeitsort. Pläne, Bescheide und Antworten liegen dort, wo das Team arbeitet, mit Fassungen, Freigabe und einem Gedächtnis dafür, was schon geklärt ist.',
              'Eine Frage wird zu Arbeit: Tiefenrecherche mit Bericht im Projekt, Befunde als offene Punkte, Aktenvermerke zur Freigabe.',
            ],
          },
          right: {
            title: 'Wofür Reiner AI gut passt',
            items: [
              'Büros in Deutschland, deren Fragen an LBO, HOAI, VOB, DIN und DWA hängen.',
              'Fertige Agenten für Bauleitung und Vergabe, vom Protokoll bis zur Schlussrechnung.',
              'Teams, die mit SharePoint oder Google Drive arbeiten und diese anbinden wollen.',
            ],
          },
        },
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Reiner AI',
          rows: [
            { label: 'Markt', a: 'Österreich', b: 'Deutschland' },
            {
              label: 'Regelwerke',
              a: 'Die neun Landesbauordnungen aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze wie ASchG und Arbeitsstättenverordnung',
              b: 'Nennt LBO, HOAI, VOB, DIN und DWA; auf der Website weder OIB-Richtlinien noch österreichisches Landesrecht',
            },
            {
              label: 'Bundesland & Ausgabe',
              a: 'Fragt nach dem Bundesland oder nennt die Annahme; nennt die OIB-Ausgabe, die dort gilt',
              b: 'Deutsche Landesbauordnungen',
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
              label: 'Aufgaben & Berichte',
              a: 'Aufgaben unter Ihrem Namen, wiederkehrende Prüfungen, Tiefenrecherche mit Bericht als PDF oder Word',
              b: 'Chat und Agenten für Bau- und Vertragsdokumente, laut Website über 50 Aufgaben',
            },
            { label: 'Training', a: 'Kein Training mit Ihren Daten', b: '„Zero-Training Policy“' },
          ],
          note: 'Angaben zu Reiner AI laut reiner.ai, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'text',
          title: 'Warum der Markt den Unterschied macht',
          body: [
            'Baurecht ist in Deutschland wie in Österreich Landesrecht, aber es sind andere Länder und andere Gesetze. Eine deutsche Landesbauordnung, die DIN und die VOB helfen einem Büro in Graz oder Linz nicht weiter. In Österreich hängen die technischen Anforderungen an den OIB-Richtlinien, die jedes Bundesland in seiner eigenen Ausgabe für verbindlich erklärt.',
            'Ein Werkzeug für österreichische Projekte muss deshalb wissen, welches Bundesland gilt, und die Fundstelle so nennen, dass Sie sie im RIS wiederfinden. Genau darauf ist Piloti gebaut: Es fragt nach dem Bundesland, liest die Bauordnung dieses Landes und legt das Ergebnis dort ab, wo Ihr Team am Projekt arbeitet.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti ist für österreichisches Recht gebaut; VOB, HOAI und deutsche Landesbauordnungen gehören nicht dazu. Die Verantwortung für die Planung bleibt beim Büro: Piloti nennt zu jeder Antwort die Quellen, damit Sie sie prüfen können, und fragt nach, wenn eine entscheidende Angabe fehlt.',
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
          a: 'Reiner AI nennt auf seiner Website 49, 99 oder 299 € je Nutzer:in und Monat bei jährlicher Abrechnung. Piloti ist in der Pilotphase mit ausgewählten Büros: Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern.',
        },
        {
          q: 'Werden meine Daten zum Training verwendet?',
          a: 'Nein. Piloti trainiert keine Modelle mit den Daten Ihres Büros, Ihre Pläne bleiben Eigentum des Büros, und Ihr Büroarchiv sieht kein anderes Büro. Reiner AI nennt ebenfalls eine „Zero-Training Policy“. Die Einzelheiten zu Piloti stehen in der Datenschutzerklärung.',
        },
      ],
    },
    en: {
      title: 'Reiner AI alternative for Austria: Piloti compared',
      description:
        'Piloti or Reiner AI (often searched as “Rainer AI”)? State building codes, OIB guidelines, evidence, drawings and project work compared for Austria.',
      heading: 'Piloti or Reiner AI?',
      lede: 'Piloti is built for planning offices in Austria: it reads the state building code, the OIB guidelines and your drawings, and backs every answer with its citation. Reiner AI is an AI tool for construction and contract documents in Germany. Here is the comparison.',
      note: 'This means Reiner AI (reiner.ai) from Germany, often searched for as “Rainer AI”. Reiner AI details as stated on reiner.ai.',
      answer:
        'For planning questions in Austria, Piloti is the better choice: it works with the nine state building codes from RIS and the OIB guidelines, checks every citation before showing it and brings tasks, reports and approvals into the project. Reiner AI is geared to German construction contracts and HOAI.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian building law as the foundation: the nine state building codes from RIS and the OIB guidelines, cited the way an official decision cites them.',
              'The state matters. Piloti names the OIB edition that applies in your project’s state and opens the RIS passage inside the tool.',
              'Evidence that holds: every citation is checked against the source text before it is shown, down to section, clause or page.',
              'The project as the place of work. Drawings, permits and answers sit where the team works, with versions, approval and a memory of what is already settled.',
              'A question becomes work: in-depth research with a report filed in the project, findings as open points, file notes sent for approval.',
            ],
          },
          right: {
            title: 'What Reiner AI is good for',
            items: [
              'Offices in Germany whose questions hinge on LBO, HOAI, VOB, DIN and DWA.',
              'Ready-made agents for site management and tendering, from minutes to the final invoice.',
              'Teams that work in SharePoint or Google Drive and want to connect them.',
            ],
          },
        },
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Reiner AI',
          rows: [
            { label: 'Market', a: 'Austria', b: 'Germany' },
            {
              label: 'Regulations',
              a: 'The nine state building codes from RIS, OIB guidelines, register of standards, federal law such as ASchG and the workplace ordinance',
              b: 'Names LBO, HOAI, VOB, DIN and DWA; its website mentions neither the OIB guidelines nor Austrian state law',
            },
            {
              label: 'State & edition',
              a: 'Asks for the state or states its assumption; names the OIB edition that applies there',
              b: 'German state building codes',
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
              label: 'Tasks & reports',
              a: 'Tasks under your name, recurring checks, in-depth research with a report as PDF or Word',
              b: 'Chat and agents for construction and contract documents, over 50 tasks according to its website',
            },
            { label: 'Training', a: 'No training on your data', b: '“Zero-Training Policy”' },
          ],
          note: 'Reiner AI details as stated on reiner.ai, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'text',
          title: 'Why the market makes the difference',
          body: [
            'Building law is state law in Germany and in Austria alike, but they are different states and different laws. A German state building code, DIN and VOB do not help an office in Graz or Linz. In Austria the technical requirements hinge on the OIB guidelines, which each state declares binding in its own edition.',
            'A tool for Austrian projects therefore has to know which state applies, and cite the passage so you find it again in RIS. That is what Piloti is built for: it asks for the state, reads that state’s building code and files the result where your team works on the project.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti is built for Austrian law; VOB, HOAI and German state building codes are not part of it. Responsibility for the design stays with the office: Piloti names the source of every answer so you can check it, and asks when a deciding fact is missing.',
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
          a: 'Reiner AI lists €49, €99 or €299 per user per month billed annually on its website. Piloti is in its pilot phase with selected offices: pilot offices agree terms directly with us, the founders.',
        },
        {
          q: 'Is my data used for training?',
          a: 'No. Piloti does not train models on your office’s data, your drawings remain the office’s property, and no other office sees your office archive. Reiner AI also states a “Zero-Training Policy”. The details for Piloti are in the privacy policy.',
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
        'Piloti oder WEKA Bau AI? Quellen, Landesbauordnungen, OIB-Richtlinien, Belege, eigene Unterlagen und Projektarbeit im Vergleich – für Büros in Österreich.',
      heading: 'Piloti oder WEKA Bau AI?',
      lede: 'Piloti arbeitet mit dem Gesetzestext, den OIB-Richtlinien und den Unterlagen Ihres Projekts, und es zitiert so, wie die Behörde zitiert. WEKA Bau AI antwortet aus der Fachdatenbank eines deutschen Verlags. Hier der Vergleich.',
      note: 'Gemeint ist WEKA Bau AI der WEKA Media GmbH & Co. KG aus Deutschland. Angaben laut weka.de, shop.weka.de und der WEKA-Pressemitteilung vom 4. Februar 2026.',
      answer:
        'Für Projekte in Österreich ist Piloti die bessere Wahl: Es liest Landesbauordnung und OIB-Richtlinien selbst, zieht Ihr Büroarchiv und Ihre Pläne heran und belegt jede Antwort mit einer geprüften Fundstelle. WEKA Bau AI passt zu deutschem Bauvertragsrecht.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Baurecht aus der Primärquelle: Landesbauordnung aus dem RIS und OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt.',
              'Die Ausgabe, die gilt. Piloti fragt nach dem Bundesland oder nennt die Annahme, und es nennt die OIB-Ausgabe, die dort verbindlich ist.',
              'Ihre eigenen Unterlagen zählen. Büroarchiv und Projektdokumente sind Quellen, und Piloti sieht Grundriss und Schnitt als Bild an.',
              'Prüfungen nach Gebäudeklasse als Tabelle, mit Quelle und Ergebnis je Zeile.',
              'Das Projekt als Arbeitsort: Aufgaben laufen unter Ihrem Namen, Befunde werden zu offenen Punkten, Entwürfe gehen in die Freigabe.',
            ],
          },
          right: {
            title: 'Wofür WEKA Bau AI gut passt',
            items: [
              'Fragen zu deutschem Bauvertragsrecht, VOB und BGB, beantwortet aus redaktionell gepflegten Fachartikeln.',
              'Entwürfe für E-Mails, Verträge und Nachträge in deutschen Bauprojekten.',
            ],
          },
        },
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
              label: 'Pläne',
              a: 'Sieht Grundriss und Schnitt als Bild an und markiert die gelesene Zeichnung',
              b: 'Auf den gelesenen Seiten nicht beschrieben',
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
          ],
          note: 'Angaben zu WEKA Bau AI laut weka.de/bi/ai, shop.weka.de/bau-ai und der Pressemitteilung vom 4. Februar 2026, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'text',
          title: 'Fachartikel oder Gesetzestext?',
          body: [
            'Die beiden Werkzeuge setzen an verschiedenen Stellen an. WEKA Bau AI antwortet aus Fachartikeln: Jemand hat die Norm schon gelesen, eingeordnet und erklärt. Das hilft bei Vertragsfragen und zur Orientierung.',
            'Die Behörde zitiert im Bescheid aber nicht den Artikel, sondern das Gesetz und die Richtlinie. In Österreich kommt dazu, dass jedes Bundesland die OIB-Richtlinien in seiner eigenen Ausgabe für verbindlich erklärt. Piloti fragt deshalb nach dem Bundesland oder nennt die Annahme, liest den Gesetzestext selbst und zeigt die Stelle, an der Sie nachprüfen. So steht in Ihrem Aktenvermerk dieselbe Fundstelle, die später im Bescheid steht.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti belegt aus Gesetz, Richtlinie und Ihren Unterlagen; die fachliche Einordnung und die Verantwortung für die Planung bleiben beim Büro. Deutsches Vertragsrecht wie VOB, BGB und HOAI gehört nicht zu Piloti. Fehlt eine entscheidende Angabe, fragt Piloti nach, statt zu raten.',
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
          a: 'Laut WEKA-Shop 499,00 € netto im Jahr als Jahreslizenz, mit 200 Anfragen pro Monat und Nutzer:in, und 14 Tage kostenlos zum Testen. Piloti ist in der Pilotphase mit ausgewählten Büros: Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern.',
        },
        {
          q: 'Kann ich eigene Unterlagen verwenden?',
          a: 'WEKA Bau AI antwortet laut Anbieter nur aus der WEKA-Datenbank. Bei Piloti sind das Archiv Ihres Büros und die Dokumente des Projekts eigene Quellen; das Archiv sieht kein anderes Büro. Hochladen lassen sich PDF, Word, Excel, PowerPoint, CSV, Bilder und ganze Ordner.',
        },
        {
          q: 'Was passiert mit den Daten meines Büros?',
          a: 'Piloti trainiert keine Modelle mit den Daten Ihres Büros, Ihre Pläne bleiben Eigentum des Büros, und Ihr Büroarchiv sieht kein anderes Büro. WEKA gibt an, die Prompts nicht zu speichern, und nennt ISO/IEC 27001. Die Einzelheiten zu Piloti stehen in der Datenschutzerklärung.',
        },
      ],
    },
    en: {
      title: 'WEKA Bau AI alternative for Austria: Piloti compared',
      description:
        'Piloti or WEKA Bau AI? Sources, state building codes, OIB guidelines, evidence, your own documents and project work compared – for offices in Austria.',
      heading: 'Piloti or WEKA Bau AI?',
      lede: 'Piloti works with the legal text, the OIB guidelines and your project’s documents, and it cites the way the authority cites. WEKA Bau AI answers from a German publisher’s expert database. Here is the comparison.',
      note: 'This means WEKA Bau AI by WEKA Media GmbH & Co. KG from Germany. Details as stated on weka.de, shop.weka.de and WEKA’s press release of 4 February 2026.',
      answer:
        'For projects in Austria, Piloti is the better choice: it reads the state building code and the OIB guidelines itself, draws on your office archive and your drawings and backs every answer with a checked citation. WEKA Bau AI suits German construction contract law.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian building law from the primary source: the state building code from RIS and the OIB guidelines, cited the way an official decision cites them.',
              'The edition that applies. Piloti asks for the state or states its assumption, and names the OIB edition that is binding there.',
              'Your own documents count. The office archive and project documents are sources, and Piloti looks at plan and section as an image.',
              'Checks by building class as tables, with source and result per row.',
              'The project as the place of work: tasks run under your name, findings become open points, drafts go out for approval.',
            ],
          },
          right: {
            title: 'What WEKA Bau AI is good for',
            items: [
              'Questions on German construction contract law, VOB and BGB, answered from editorially maintained expert articles.',
              'Drafts for e-mails, contracts and change orders in German building projects.',
            ],
          },
        },
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
              label: 'Drawings',
              a: 'Looks at plan and section as an image and marks the drawing it read',
              b: 'Not described on the pages we read',
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
          ],
          note: 'WEKA Bau AI details as stated on weka.de/bi/ai, shop.weka.de/bau-ai and the press release of 4 February 2026, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'text',
          title: 'Expert article or legal text?',
          body: [
            'The two tools start in different places. WEKA Bau AI answers from expert articles: someone has already read the rule, placed it and explained it. That helps with contract questions and for orientation.',
            'In its decision, though, the authority cites the law and the guideline, not the article. In Austria, each state also declares the OIB guidelines binding in its own edition. So Piloti asks for the state or states its assumption, reads the legal text itself and shows the passage where you check it. Your file note then carries the same citation the decision will carry later.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti cites law, guideline and your documents; the professional judgement and responsibility for the design stay with the office. German contract law such as VOB, BGB and HOAI is not part of Piloti. When a deciding fact is missing, Piloti asks instead of guessing.',
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
          a: 'According to the WEKA shop, €499.00 net per year as an annual licence, with 200 requests per month per user, and a 14-day free trial. Piloti is in its pilot phase with selected offices: pilot offices agree terms directly with us, the founders.',
        },
        {
          q: 'Can I use my own documents?',
          a: 'According to the vendor, WEKA Bau AI answers only from the WEKA database. With Piloti, your office archive and the project’s documents are sources in their own right; no other office sees the archive. You can upload PDF, Word, Excel, PowerPoint, CSV, images and whole folders.',
        },
        {
          q: 'What happens to my office’s data?',
          a: 'Piloti does not train models on your office’s data, your drawings remain the office’s property, and no other office sees your office archive. WEKA says it does not store prompts and cites ISO/IEC 27001. The details for Piloti are in the privacy policy.',
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
        'Piloti oder BauKI? Landesbauordnungen, OIB-Richtlinien, Belege, Büroarchiv, Berichte und Projektarbeit im Vergleich – für Planungsbüros in Österreich.',
      heading: 'Piloti oder BauKI?',
      lede: 'Piloti ist für österreichische Projekte gebaut: Landesbauordnung aus dem RIS, OIB-Richtlinien in der Ausgabe des Bundeslands, Pläne als Bild gelesen, Arbeit im Projekt. BauKI ist ein Werkzeug zum Selbstanmelden für Bauvorschriften in Deutschland. Hier der Vergleich.',
      note: 'Gemeint ist BauKI (bauki.eu) der Plandirekt24 UG aus Mölln, Deutschland. Angaben zu BauKI laut bauki.eu.',
      answer:
        'Für Planungsbüros in Österreich ist Piloti die bessere Wahl: Es arbeitet mit Landesbauordnung und OIB-Richtlinien, prüft nach Gebäudeklasse mit Quelle je Zeile und macht aus einer Frage Aufgaben, Berichte und Freigaben im Projekt. BauKI zielt auf deutsche Baugesetze.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Landesrecht aus dem RIS und die OIB-Richtlinien in der Ausgabe, die im Bundesland gilt, zitiert, wie ein Bescheid sie nennt.',
              'Prüfungen nach Gebäudeklasse als Tabelle, mit Quelle und Ergebnis je Zeile („2 erfüllt · 1 offen“).',
              'Pläne und Fotos werden als Bild gelesen, dazu IFC-Vorschau und Modellbereich.',
              'Arbeit statt Chat: Aufgaben bis Freitag, wiederkehrende Prüfungen, Befunde als offene Punkte im Projektgedächtnis.',
              'Freigabe im Büro: Ein Dokument von Piloti wird erst zur zitierbaren Quelle, wenn das Büro es freigibt und veröffentlicht.',
            ],
          },
          right: {
            title: 'Wofür BauKI gut passt',
            items: [
              'Planung in Deutschland, mit Paragrafen aus deutschen Baugesetzen und KfW- und BAFA-Programmen.',
              'Wer selbst anmelden und im Monatsabo loslegen will.',
              'Ein fertiger Prüfbericht mit Logo und Unterschriftsfeld, dazu Google-Drive-Anbindung.',
            ],
          },
        },
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
              label: 'Pläne & Modelle',
              a: 'Pläne und Fotos werden als Bild angesehen; IFC-Vorschau und Modellbereich',
              b: 'IFC-Viewer',
            },
            {
              label: 'Ausgabe',
              a: 'Aktenvermerk, Protokoll, Checkliste; Bericht der Tiefenrecherche als PDF oder Word; Freigabe im Büro',
              b: 'Word, PDF und Excel, darunter ein „Prüfbericht mit Logo … und Unterschriftsfeld“',
            },
            {
              label: 'Projektarbeit',
              a: 'Projekte mit Fassungen, Freigabe, Aufgaben, wiederkehrenden Prüfungen und Projektgedächtnis',
              b: 'Projekte bündeln Chats, Dokumente und Notizen',
            },
          ],
          note: 'Angaben zu BauKI laut bauki.eu, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'text',
          title: 'Für welches Land antwortet es?',
          body: [
            'BauKI bietet für deutsche Projekte viel: Gesetzesbibliothek, Paragrafenbelege, eine eigene Wissensdatenbank, IFC-Viewer und Berichte zum Unterschreiben.',
            'Für ein Projekt in Salzburg oder Linz entscheidet aber zuerst, welches Recht gilt. Die Auswahl „Bundesland“ meint bei BauKI deutsche Länder. Ein Paragraf aus dem BauGB hilft bei einer Einreichung in Österreich nicht, und die OIB-Richtlinien stehen auf bauki.eu nicht unter den abgedeckten Quellen. Piloti zitiert die Landesbauordnung so, wie ein Bescheid sie nennt, öffnet die RIS-Stelle direkt im Werkzeug und legt das Ergebnis als Bericht oder offenen Punkt im Projekt ab.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti ist für österreichisches Recht gebaut; deutsches Baurecht und Förderprogramme wie KfW oder BAFA gehören nicht dazu. Die Verantwortung für die Planung bleibt beim Büro: Piloti nennt zu jeder Antwort die Quellen und fragt nach, wenn Gebäudeklasse, Bundesland oder Art des Vorhabens fehlen.',
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
          a: 'BauKI nennt 23,00 € und 49,00 € im Monat zuzüglich Mehrwertsteuer, monatlich kündbar, und 5 Tage kostenlos. Piloti ist in der Pilotphase mit ausgewählten Büros: Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern.',
        },
        {
          q: 'Kann Piloti einen Prüfbericht erstellen?',
          a: 'Piloti schreibt Aktenvermerke, Protokolle und Checklisten und legt den Bericht einer Tiefenrecherche mit Urteil und Befundmatrix im Projekt ab, als PDF oder Word. Ein Dokument von Piloti wird erst zur zitierbaren Quelle, wenn das Büro es freigibt und veröffentlicht.',
        },
        {
          q: 'Was passiert mit den Daten meines Büros?',
          a: 'Piloti trainiert keine Modelle mit den Daten Ihres Büros, Pläne bleiben Eigentum des Büros, und Ihr Büroarchiv sieht kein anderes Büro. Die Einzelheiten stehen in der Datenschutzerklärung.',
        },
      ],
    },
    en: {
      title: 'BauKI alternative for Austria: Piloti compared',
      description:
        'Piloti or BauKI? State building codes, OIB guidelines, evidence, office archive, reports and project work compared – for planning offices in Austria.',
      heading: 'Piloti or BauKI?',
      lede: 'Piloti is built for Austrian projects: the state building code from RIS, the OIB guidelines in the state’s edition, drawings read as images, work inside the project. BauKI is a self-serve tool for building regulations in Germany. Here is the comparison.',
      note: 'This means BauKI (bauki.eu) by Plandirekt24 UG from Mölln, Germany. BauKI details as stated on bauki.eu.',
      answer:
        'For planning offices in Austria, Piloti is the better choice: it works with the state building code and the OIB guidelines, checks by building class with a source on every row and turns a question into tasks, reports and approvals in the project. BauKI targets German building laws.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian state law from RIS and the OIB guidelines in the edition that applies in the state, cited the way an official decision cites them.',
              'Checks by building class as tables, with source and result per row (“2 met · 1 open”).',
              'Drawings and photos are read as images, plus IFC preview and model area.',
              'Work, not just chat: tasks due Friday, recurring checks, findings as open points in the project memory.',
              'Office approval: a document written by Piloti only becomes a citable source once the office approves and publishes it.',
            ],
          },
          right: {
            title: 'What BauKI is good for',
            items: [
              'Planning in Germany, with sections from German building laws and KfW and BAFA programmes.',
              'Signing up yourself and starting on a monthly plan.',
              'A ready-made inspection report with logo and signature field, plus Google Drive sync.',
            ],
          },
        },
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
              label: 'Drawings & models',
              a: 'Drawings and photos are looked at as images; IFC preview and model area',
              b: 'IFC viewer',
            },
            {
              label: 'Output',
              a: 'File note, minutes, checklist; in-depth research report as PDF or Word; approval in the office',
              b: 'Word, PDF and Excel, including an “inspection report with logo … and signature field”',
            },
            {
              label: 'Project work',
              a: 'Projects with versions, approval, tasks, recurring checks and project memory',
              b: 'Projects bundle chats, documents and notes',
            },
          ],
          note: 'BauKI details as stated on bauki.eu, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'text',
          title: 'Which country does it answer for?',
          body: [
            'For German projects BauKI offers a lot: a law library, section references, a knowledge base of your own, an IFC viewer and reports ready to sign.',
            'For a project in Salzburg or Linz, though, the first question is which law applies. BauKI’s “state” selection means German states. A section of the BauGB does not help with a submission in Austria, and the OIB guidelines are not listed among the covered sources on bauki.eu. Piloti cites the state building code the way an official decision cites it, opens the RIS passage inside the tool and files the result in the project as a report or an open point.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti is built for Austrian law; German building law and funding programmes such as KfW or BAFA are not part of it. Responsibility for the design stays with the office: Piloti names the source of every answer and asks when the building class, the state or the type of project is missing.',
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
          a: 'BauKI lists €23.00 and €49.00 per month plus VAT, cancellable monthly, and 5 days free. Piloti is in its pilot phase with selected offices: pilot offices agree terms directly with us, the founders.',
        },
        {
          q: 'Can Piloti produce an inspection report?',
          a: 'Piloti writes file notes, minutes and checklists and files an in-depth research report with verdict and findings matrix in the project, as PDF or Word. A document written by Piloti only becomes a citable source once the office approves and publishes it.',
        },
        {
          q: 'What happens to my office’s data?',
          a: 'Piloti does not train models on your office’s data, drawings remain the office’s property, and no other office sees your office archive. The details are in the privacy policy.',
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
        'Piloti oder K24AI? Beide nennen OIB-Richtlinien und Bürodokumente. Landesrecht, Belege, Projektarbeit und Verfügbarkeit im Vergleich, mit Datum.',
      heading: 'Piloti oder K24AI?',
      lede: 'Piloti ist heute im Einsatz: Pilotbüros stellen echte Projektfragen zu Landesbauordnung und OIB-Richtlinien und bekommen belegte Antworten im Projekt. K24AI setzt ähnlich an, mit OIB-Richtlinien, Normen und eigenen Bürounterlagen. Hier, worin sie sich unterscheiden.',
      note: 'Gemeint ist K24AI (k24ai.com). Angaben zu K24AI laut k24ai.com, einschließlich des dortigen Hinweises vom Juli 2026.',
      answer:
        'Piloti ist die Wahl, die Büros heute nutzen können: Es arbeitet mit den Landesbauordnungen aus dem RIS und den OIB-Richtlinien und bringt Aufgaben, Berichte und Freigaben ins Projekt. K24AI hat laut eigener Website den Alpha-Start verschoben und nimmt keine neuen Tester auf.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Heute in Betrieb. Pilotbüros stellen echte Projektfragen, und neue Büros können mit einer echten Frage testen.',
              'Die Landesbauordnungen aus dem RIS, zitiert, wie ein Bescheid sie nennt, mit der OIB-Ausgabe, die im Bundesland gilt.',
              'Jede Fundstelle wird vor dem Anzeigen gegen den Quelltext geprüft, und RIS-Stellen öffnen direkt im Werkzeug.',
              'Arbeitsweisen für Gebäudeklasse, Brandschutz, Einreichcheck, Bestand und Bebauung, und das Büro kann eigene ergänzen.',
              'Das Projekt als Arbeitsort: Aufgaben, Tiefenrecherche mit Bericht, offene Punkte und Freigabe, bevor ein Dokument als Quelle gilt.',
            ],
          },
          right: {
            title: 'Wofür K24AI gut passt',
            items: [
              'Büros, die Rechtsquellen aus Österreich, Deutschland, der Schweiz und dem europäischen Recht in einem Werkzeug suchen.',
              'DIN-Normen als Quelle und Werkzeuge wie Wissensgraph, Mindmap und Konflikt-Scanner.',
            ],
          },
        },
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
              label: 'Pläne',
              a: 'Sieht Grundriss und Schnitt als Bild an und markiert die gelesene Zeichnung',
              b: 'Auf der Website nicht beschrieben',
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
            { label: 'Training', a: 'Kein Training mit Ihren Daten', b: '„Kein Training mit Ihren Dokumenten“' },
          ],
          note: 'Angaben zu K24AI laut k24ai.com, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'text',
          title: 'Ähnlicher Ansatz, anderer Stand',
          body: [
            'K24AI beschreibt, was viele Büros in Österreich suchen: OIB-Richtlinien und Bürodokumente an einem Ort, Antworten mit Zitat, Konflikte zwischen Regeln sichtbar gemacht. Das ist nah an dem, was Piloti macht, und wir halten den Ansatz für richtig.',
            'Der Unterschied liegt heute im Stand. Laut Hinweis auf k24ai.com vom Juli 2026 ist der Alpha-Start verschoben, die Wissensbasis wird neu aufgebaut, und neue Tester werden vorerst nicht aufgenommen. Piloti beantwortet Projektfragen von Pilotbüros schon heute, mit dem Landesrecht aus dem RIS, und bringt Aufgaben, Berichte und Freigaben ins Projekt.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti bleibt bei Österreich; deutsches und Schweizer Baurecht gehören nicht dazu. Die Verantwortung für die Planung bleibt beim Büro: Piloti nennt zu jeder Antwort die Quellen, damit Sie sie prüfen können, und fragt nach, wenn eine entscheidende Angabe fehlt.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann ich K24AI derzeit nutzen?',
          a: 'Laut Hinweis auf k24ai.com vom Juli 2026 ist der Alpha-Start verschoben, die Wissensbasis wird neu aufgebaut, und neue Tester werden vorerst nicht aufgenommen. Wie es weitergeht, sagt am verlässlichsten die Website selbst. Piloti können Büros mit einer echten Frage testen.',
        },
        {
          q: 'Worin unterscheiden sich K24AI und Piloti?',
          a: 'Beide arbeiten mit OIB-Richtlinien und Bürodokumenten und zitieren ihre Quellen. K24AI nennt dazu DIN-Normen und Rechtsquellen aus Deutschland und der Schweiz. Piloti konzentriert sich auf Österreich, arbeitet mit den neun Landesbauordnungen aus dem RIS und bringt Aufgaben, Berichte und Freigaben ins Projekt.',
        },
        {
          q: 'Was kostet K24AI?',
          a: 'K24AI gibt an, dass die Preise noch nicht festgelegt sind (Stand September 2026). Piloti ist in der Pilotphase mit ausgewählten Büros: Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern.',
        },
        {
          q: 'Was passiert mit den Daten meines Büros?',
          a: 'Piloti trainiert keine Modelle mit den Daten Ihres Büros, Pläne bleiben Eigentum des Büros, und Ihr Büroarchiv sieht kein anderes Büro. K24AI nennt ebenfalls „Kein Training mit Ihren Dokumenten“. Die Einzelheiten zu Piloti stehen in der Datenschutzerklärung.',
        },
      ],
    },
    en: {
      title: 'K24AI alternative: Piloti compared for Austria',
      description:
        'Piloti or K24AI? Both name the OIB guidelines and office documents. State law, evidence, project work and availability compared, with a date.',
      heading: 'Piloti or K24AI?',
      lede: 'Piloti is in use today: pilot offices ask real project questions on the state building code and the OIB guidelines and get answers with evidence inside the project. K24AI takes a similar approach, with OIB guidelines, standards and your own office documents. Here is how they differ.',
      note: 'This means K24AI (k24ai.com). K24AI details as stated on k24ai.com, including its notice of July 2026.',
      answer:
        'Piloti is the choice offices can use today: it works with the state building codes from RIS and the OIB guidelines and brings tasks, reports and approvals into the project. According to its website, K24AI has postponed its alpha start and is not taking new testers.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'Running today. Pilot offices ask real project questions, and new offices can test with a real question.',
              'The state building codes from RIS, cited the way an official decision cites them, with the OIB edition that applies in the state.',
              'Every citation is checked against the source text before it is shown, and RIS passages open inside the tool.',
              'Ways of working for building class, fire safety, submission check, existing buildings and plot rules, and the office can add its own.',
              'The project as the place of work: tasks, in-depth research with a report, open points and approval before a document counts as a source.',
            ],
          },
          right: {
            title: 'What K24AI is good for',
            items: [
              'Offices looking for legal sources from Austria, Germany, Switzerland and European law in one tool.',
              'DIN standards as a source and tools such as a knowledge graph, mind map and conflict scanner.',
            ],
          },
        },
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
              label: 'Drawings',
              a: 'Looks at plan and section as an image and marks the drawing it read',
              b: 'Not described on the website',
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
            { label: 'Training', a: 'No training on your data', b: '“No training on your documents”' },
          ],
          note: 'K24AI details as stated on k24ai.com, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'text',
          title: 'Similar approach, different stage',
          body: [
            'K24AI describes what many offices in Austria are looking for: OIB guidelines and office documents in one place, answers with citations, conflicts between rules made visible. That is close to what Piloti does, and we think the approach is right.',
            'Today the difference lies in the stage. According to a notice on k24ai.com from July 2026, the alpha start is postponed, the knowledge base is being rebuilt and new testers are not being taken on for now. Piloti already answers pilot offices’ project questions today, with state law from RIS, and brings tasks, reports and approvals into the project.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti stays with Austria; German and Swiss building law are not part of it. Responsibility for the design stays with the office: Piloti names the source of every answer so you can check it, and asks when a deciding fact is missing.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can I use K24AI right now?',
          a: 'According to a notice on k24ai.com from July 2026, the alpha start is postponed, the knowledge base is being rebuilt and new testers are not being taken on for now. The website itself is the most reliable place to see what happens next. Offices can test Piloti with a real question.',
        },
        {
          q: 'How do K24AI and Piloti differ?',
          a: 'Both work with the OIB guidelines and office documents and cite their sources. K24AI also names DIN standards and legal sources from Germany and Switzerland. Piloti concentrates on Austria, works with the nine state building codes from RIS and brings tasks, reports and approvals into the project.',
        },
        {
          q: 'What does K24AI cost?',
          a: 'K24AI states that prices have not yet been set (as of September 2026). Piloti is in its pilot phase with selected offices: pilot offices agree terms directly with us, the founders.',
        },
        {
          q: 'What happens to my office’s data?',
          a: 'Piloti does not train models on your office’s data, drawings remain the office’s property, and no other office sees your office archive. K24AI also states “no training on your documents”. The details for Piloti are in the privacy policy.',
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
        'BaurechtGPT vom Forum Verlag oder Piloti? Rechtsgrundlage, Belege, Unterlagen und Projektarbeit im Vergleich – und warum der Name nicht Österreich meint.',
      heading: 'BaurechtGPT oder Piloti für österreichisches Baurecht?',
      lede: 'Piloti ist für österreichisches Baurecht gebaut: Landesbauordnung aus dem RIS, OIB-Richtlinien, Ihre Pläne und Unterlagen, jede Antwort mit geprüfter Fundstelle. BaurechtGPT ist ein Chatbot der Forum Verlag Herkert GmbH, einem Fachverlag aus Deutschland, und antwortet aus deutschem Recht.',
      note: 'Gemeint ist BaurechtGPT (gpt.forum-verlag.com) der Forum Verlag Herkert GmbH, Deutschland. Angaben laut Forum Verlag, auf gpt.forum-verlag.com und im Forum-Verlag-Shop.',
      answer:
        'Für österreichisches Baurecht ist Piloti die bessere Wahl: Es arbeitet mit den neun Landesbauordnungen aus dem RIS und den OIB-Richtlinien, liest Ihre Pläne und belegt jede Antwort mit einer geprüften Fundstelle. BaurechtGPT beruht laut Forum Verlag auf deutschem Recht.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Landesrecht aus dem RIS und die OIB-Richtlinien, zitiert, wie ein Bescheid sie nennt.',
              'Die Ausgabe, die gilt: Piloti nennt die OIB-Ausgabe, die im Bundesland Ihres Projekts verbindlich ist.',
              'Ihre Pläne und Unterlagen: Büroarchiv und Projektdokumente sind Quellen, Grundriss und Schnitt werden als Bild gelesen.',
              'Mehr als Antworten: Einreichcheck, Tiefenrecherche mit Bericht, Aktenvermerke zur Freigabe.',
              'Arbeit im Team: Projekte mit Aufgaben, Fassungen, Freigabe und einem Gedächtnis für Geklärtes und Offenes.',
            ],
          },
          right: {
            title: 'Wofür BaurechtGPT gut passt',
            items: [
              'Fragen zum deutschen Baurecht, beantwortet aus einer Datenbasis, die Fachjurist:innen eines Verlags kuratieren.',
              'Deutsches Bauvertragsrecht, Gewährleistung und Haftung nach BGB und VOB.',
            ],
          },
        },
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'BaurechtGPT',
          rows: [
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
              label: 'Aufgaben & Berichte',
              a: 'Einreichcheck, Tiefenrecherche mit Bericht als PDF oder Word, Aktenvermerke zur Freigabe',
              b: 'Auf den gelesenen Seiten nicht genannt',
            },
          ],
          note: 'Angaben zu BaurechtGPT laut Forum Verlag, auf gpt.forum-verlag.com/baurecht und shop.forum-verlag.com, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'text',
          title: 'Der Name sagt „Baurecht“, gemeint ist deutsches',
          body: [
            'Wer in Österreich nach „BaurechtGPT“ sucht, erwartet leicht ein Werkzeug für das eigene Baurecht. Laut Forum Verlag beruhen die Antworten aber auf BauGB, BGB, VOB und den Landesbauordnungen; gemeint sind deutsche Gesetze. Österreich taucht auf den Seiten nur als Rechnungsland auf.',
            'Für österreichische Projekte ist das mehr als ein Detail. Die Bauordnung für Wien, die NÖ Bauordnung 2014 oder die Tiroler Bauordnung 2022 regeln andere Dinge als eine deutsche Landesbauordnung, und die technischen Anforderungen stehen in den OIB-Richtlinien in der Ausgabe, die das jeweilige Land für verbindlich erklärt hat. Piloti unterscheidet das: Es fragt nach dem Bundesland, zitiert dessen Bauordnung und öffnet die Stelle im RIS.',
          ],
        },
        {
          kind: 'text',
          title: 'Gut zu wissen',
          body: [
            'Piloti liefert eine belegte Arbeitsgrundlage, keine Rechtsberatung; die Entscheidung und die Verantwortung für die Planung bleiben beim Büro. Deutsches Recht und Vertragsrecht gehören nicht zu Piloti. Fehlt eine entscheidende Angabe, fragt Piloti nach oder nennt seine Annahme.',
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
          a: 'Auf gpt.forum-verlag.com nennt der Verlag 39 € im Monat oder 390 € im Jahr, jeweils zuzüglich Mehrwertsteuer. Im Shop wird es als Jahresbezug mit 75 Prompts pro Monat angeboten. Piloti ist in der Pilotphase mit ausgewählten Büros: Pilotbüros vereinbaren die Bedingungen direkt mit uns Gründern.',
        },
        {
          q: 'Was passiert mit den Daten meines Büros?',
          a: 'Piloti trainiert keine Modelle mit den Daten Ihres Büros, Pläne bleiben Eigentum des Büros, und Ihr Büroarchiv sieht kein anderes Büro. Auch der Forum Verlag gibt an, keine Modelle mit Kundendaten zu trainieren. Die Einzelheiten zu Piloti stehen in der Datenschutzerklärung.',
        },
      ],
    },
    en: {
      title: 'BaurechtGPT for Austria? Piloti compared',
      description:
        'BaurechtGPT by Forum Verlag or Piloti? Legal basis, evidence, own documents and project work compared – and why the name does not mean Austrian law.',
      heading: 'BaurechtGPT or Piloti for Austrian building law?',
      lede: 'Piloti is built for Austrian building law: the state building code from RIS, the OIB guidelines, your drawings and documents, every answer with a checked citation. BaurechtGPT is a chatbot by Forum Verlag Herkert GmbH, a specialist publisher from Germany, and answers from German law.',
      note: 'This means BaurechtGPT (gpt.forum-verlag.com) by Forum Verlag Herkert GmbH, Germany. Details as stated by Forum Verlag on gpt.forum-verlag.com and in the Forum Verlag shop.',
      answer:
        'For Austrian building law, Piloti is the better choice: it works with the nine state building codes from RIS and the OIB guidelines, reads your drawings and backs every answer with a checked citation. According to Forum Verlag, BaurechtGPT rests on German law.',
      blocks: [
        {
          kind: 'split',
          left: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian state law from RIS and the OIB guidelines, cited the way an official decision cites them.',
              'The edition that applies: Piloti names the OIB edition that is binding in your project’s state.',
              'Your drawings and documents: the office archive and project documents are sources, plan and section are read as images.',
              'More than answers: submission check, in-depth research with a report, file notes sent for approval.',
              'Teamwork: projects with tasks, versions, approval and a memory of what is settled and what is open.',
            ],
          },
          right: {
            title: 'What BaurechtGPT is good for',
            items: [
              'Questions on German building law, answered from a database curated by a publisher’s legal experts.',
              'German construction contract law, warranty and liability under BGB and VOB.',
            ],
          },
        },
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'BaurechtGPT',
          rows: [
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
              label: 'Tasks & reports',
              a: 'Submission check, in-depth research with a report as PDF or Word, file notes sent for approval',
              b: 'Not mentioned on the pages we read',
            },
          ],
          note: 'BaurechtGPT details as stated by Forum Verlag on gpt.forum-verlag.com/baurecht and shop.forum-verlag.com, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'text',
          title: 'The name says “building law”, but it means German law',
          body: [
            'Anyone in Austria searching for “BaurechtGPT” may well expect a tool for their own building law. According to Forum Verlag, though, the answers rest on BauGB, BGB, VOB and the state building codes; these are German laws. Austria appears on its pages only as a billing country.',
            'For Austrian projects this is more than a detail. The Vienna Building Code, the Lower Austrian Building Code 2014 or the Tyrolean Building Code 2022 govern different things from a German state building code, and the technical requirements sit in the OIB guidelines, in the edition each state has declared binding. Piloti tells these apart: it asks for the state, cites that state’s building code and opens the passage in RIS.',
          ],
        },
        {
          kind: 'text',
          title: 'Good to know',
          body: [
            'Piloti delivers a documented working basis, not legal advice; the decision and responsibility for the design stay with the office. German law and contract law are not part of Piloti. When a deciding fact is missing, Piloti asks or states its assumption.',
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
          a: 'On gpt.forum-verlag.com the publisher lists €39 per month or €390 per year, plus VAT. In its shop it is offered as an annual subscription with 75 prompts per month. Piloti is in its pilot phase with selected offices: pilot offices agree terms directly with us, the founders.',
        },
        {
          q: 'What happens to my office’s data?',
          a: 'Piloti does not train models on your office’s data, drawings remain the office’s property, and no other office sees your office archive. Forum Verlag also says it does not train models on customer data. The details for Piloti are in the privacy policy.',
        },
      ],
    },
  },
]
