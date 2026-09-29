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
]
