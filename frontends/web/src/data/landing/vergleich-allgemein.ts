/**
 * Piloti next to general AI assistants an office may already use, and next to
 * researching by hand. Each column on the other side says only what that
 * vendor's own pages say, read in the month `checked` names; where the other
 * tool is ahead, the page says so first. No prices for tools that do not
 * publish a stable one on the page we read.
 */
import type { LandingEntry } from '../../lib/landing'

export const vergleichAllgemein: LandingEntry[] = [
  {
    slug: 'chatgpt',
    checked: '2026-09',
    related: ['vergleich/microsoft-copilot', 'vergleich/perplexity', 'vergleich/ris-und-google', 'glossar/oib-richtlinien', 'anwendungen/gebaeudeklasse'],
    de: {
      title: 'ChatGPT für Baurecht in Österreich? Piloti im Vergleich',
      description:
        'ChatGPT für Baurecht und Architekten: was es gut kann, wo Bundesland, OIB-Ausgabe und Belege fehlen, und was bei DSGVO und Training im Büro zählt.',
      heading: 'ChatGPT oder Piloti für Baurecht?',
      lede: 'In vielen Büros schreibt ChatGPT schon Mails und Zusammenfassungen. Reicht es auch für Baurecht? Hier der Vergleich, zuerst das, was ChatGPT besser kann.',
      note: 'Angaben zu ChatGPT laut OpenAI (openai.com, help.openai.com), gelesen im September 2026. Preise nennen wir nicht, weil sie je Tarif und Region wechseln.',
      answer:
        'Für Texte, Zusammenfassungen und Entwürfe ist ChatGPT ein gutes Werkzeug. Für die Frage, was für ein Projekt in einem bestimmten Bundesland gilt, fehlt ihm ein geprüfter Bestand an österreichischem Baurecht mit Ausgabe und Fundstelle; dafür ist Piloti gebaut.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'ChatGPT',
          rows: [
            {
              label: 'Wofür gebaut',
              a: 'Planungsfragen österreichischer Projekte, belegt, bis zum Aktenvermerk und zur Freigabe',
              b: 'Allgemeiner Assistent für Text, Recherche, Analyse und Code',
            },
            {
              label: 'Baurecht',
              a: 'Die neun Landesbauordnungen aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze wie das ASchG',
              b: 'Kein eigener Bestand; antwortet aus dem Modell, aus einer Websuche oder aus Ihren Dateien',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Fragt nach dem Bundesland oder nennt die Annahme; nennt die OIB-Ausgabe, die dort gilt, wenn sie den Wert verändert',
              b: 'Nur so gut, wie Sie beides in der Frage angeben und die Quelle selbst prüfen',
            },
            {
              label: 'Belege',
              a: 'Fundstelle wie in einem Bescheid, vor dem Anzeigen gegen den Quelltext geprüft; RIS-Quellen öffnen an der markierten Stelle',
              b: 'Links bei Websuche und angebundenen Firmenquellen; ohne Quelle kann ein Sprachmodell Fundstellen erfinden',
            },
            {
              label: 'Projekt und Team',
              a: 'Projekte mit Plänen, Dateien, Fassungen, Projektgedächtnis, Aufgaben und Freigabe im Posteingang',
              b: 'Unterhaltungen; in ChatGPT Business laut OpenAI Anbindung von Firmenwissen wie SharePoint und Google Drive, mit Links zurück zur Quelle',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut OpenAI: Business und Enterprise standardmäßig kein Training; Free und Plus standardmäßig an, in den Einstellungen abschaltbar',
            },
            {
              label: 'Datenstandort',
              a: 'Anmeldung über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, auch außerhalb der EU; kein Versprechen zum Datenstandort',
              b: 'Laut OpenAI Speicherung in Europa für einige Business-Tarife, schrittweise eingeführt; gilt für die Speicherung, nicht für die Verarbeitung',
            },
          ],
          note: 'Angaben zu ChatGPT laut OpenAI, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo ChatGPT vorn liegt',
            items: [
              'Texte. Mails an Bauherr:innen, Baubeschreibungen, Zusammenfassungen langer Bescheide oder Gutachten schreibt ChatGPT schnell und gut.',
              'Breite: Excel-Formeln, Übersetzungen, Code, weit über das Baurecht hinaus.',
              'Sofort nutzbar, mit öffentlichen Tarifen.',
              'Ein Unternehmen am Markt. Piloti ist in Gründung und in der Pilotphase.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Ein gepflegter Bestand an österreichischem Baurecht: Landesbauordnungen aus dem RIS und OIB-Richtlinien, zitiert bis zum Paragraf oder Punkt.',
              'Bundesland und Ausgabe als Teil der Antwort. Fehlt das Bundesland oder die Gebäudeklasse, fragt Piloti nach oder nennt die Annahme.',
              'Das Projekt als Arbeitsort: Pläne, Aufgaben, Aktenvermerke zur Freigabe und ein Gedächtnis für das, was schon geklärt ist.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Warum eine gute Formulierung nicht reicht',
          body: [
            'Eine Frage wie „Wie lang darf der Fluchtweg hier sein?“ hat in Österreich nicht eine Antwort. Sie hängt vom Bundesland ab, von der OIB-Ausgabe, die das Land für verbindlich erklärt hat, und von der Gebäudeklasse. Laut OIB-Übersicht gilt die Ausgabe 2023 in Wien, Kärnten, Niederösterreich, Oberösterreich und Tirol ganz oder teilweise, in den anderen vier Ländern im Allgemeinen noch die Ausgabe 2019. Ein allgemeines Sprachmodell hat das nicht verlässlich parat und sagt selten dazu, von welcher Fassung es ausgeht.',
            'Dazu kommt das Zitat. Ein Sprachmodell schreibt Paragrafen, die plausibel klingen, auch wenn es sie so nicht gibt. Wer die Fundstelle nicht selbst im RIS aufschlägt, übernimmt sie ungeprüft in den Aktenvermerk.',
            'Ausführlicher dazu im Journal-Beitrag „ChatGPT für Baurecht? Wo es an Grenzen stößt“.',
          ],
        },
        {
          kind: 'text',
          title: 'Datenschutz im Planungsbüro',
          body: [
            'Für die DSGVO zählt zuerst der Tarif. Laut OpenAI trainiert ChatGPT Business und Enterprise standardmäßig nicht mit Ihren Daten, Free und Plus schon, abschaltbar in den Einstellungen. Wer Pläne oder Namen von Bauherr:innen in ein privates Konto kopiert, sollte das wissen.',
            'Piloti trainiert keine Modelle mit Büro-Daten und verspricht keinen Datenstandort; die Wege stehen in der Tabelle. Büros können einen eigenen Anbieter-Schlüssel verwenden.',
          ],
        },
        {
          kind: 'text',
          title: 'Wo Piloti aufhört',
          body: [
            'Piloti ist kein allgemeiner Assistent: Für ein Anschreiben oder eine Übersetzung nehmen Sie ChatGPT. Piloti führt das Normenverzeichnis, nicht die ÖNORM-Texte, und nimmt Ihnen die Prüfung nicht ab. Es zeigt, woher eine Antwort kommt, damit Sie sie prüfen können.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann ich ChatGPT für Baurecht in Österreich nutzen?',
          a: 'Als Ausgangspunkt ja, als Beleg nein. ChatGPT erklärt Begriffe gut, hat aber keinen gepflegten Bestand an Landesbauordnungen und OIB-Richtlinien. Jede Fundstelle sollten Sie im RIS oder in der OIB-Richtlinie selbst nachschlagen.',
        },
        {
          q: 'Ist ChatGPT im Planungsbüro DSGVO-konform?',
          a: 'Das hängt vom Tarif und von Ihrer Vereinbarung mit OpenAI ab, nicht vom Werkzeug allein. Laut OpenAI werden Business- und Enterprise-Daten standardmäßig nicht zum Training verwendet, in Free und Plus schon, abschaltbar. Die Bewertung für Ihr Büro gehört in Ihre Datenschutzberatung.',
        },
        {
          q: 'Welche ChatGPT-Alternative passt für Architekten in Österreich?',
          a: 'Das hängt von der Aufgabe ab. Für Texte und allgemeine Fragen bleibt ChatGPT stark. Für Fragen, deren Antwort in eine Einreichung oder einen Aktenvermerk geht, braucht es ein Werkzeug mit österreichischem Baurecht, Bundesland-Logik und geprüften Fundstellen. Dafür ist Piloti gebaut, heute in der Pilotphase mit ausgewählten Büros.',
        },
      ],
    },
    en: {
      title: 'ChatGPT for Austrian building law? Piloti compared',
      description:
        'ChatGPT for building law and architects: what it does well, where state, OIB edition and evidence are missing, and what matters for GDPR and training.',
      heading: 'ChatGPT or Piloti for building law?',
      lede: 'Many offices already use ChatGPT for emails and summaries. Is it enough for building law? Here is the comparison, starting with what ChatGPT does better.',
      note: 'ChatGPT details as stated by OpenAI (openai.com, help.openai.com), read in September 2026. We do not list prices, because they vary by plan and region.',
      answer:
        'For text, summaries and drafts, ChatGPT is a good tool. For the question of what applies to a project in a given Austrian state, it lacks a maintained body of Austrian building law with edition and citation; that is what Piloti is built for.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'ChatGPT',
          rows: [
            {
              label: 'Built for',
              a: 'Planning questions on Austrian projects, with evidence, through to the file note and approval',
              b: 'General assistant for writing, research, analysis and code',
            },
            {
              label: 'Building law',
              a: 'The nine state building codes from RIS, OIB guidelines, register of standards, federal law such as ASchG',
              b: 'No body of its own; answers from the model, a web search or your files',
            },
            {
              label: 'State and edition',
              a: 'Asks for the state or states its assumption; names the OIB edition in force there when it changes the value',
              b: 'Only as good as your question states both and you check the source yourself',
            },
            {
              label: 'Evidence',
              a: 'Citation the way an official decision cites, checked against the source text before it is shown; RIS sources open at the marked passage',
              b: 'Links with web search and connected company sources; without a source, a language model can invent citations',
            },
            {
              label: 'Project and team',
              a: 'Projects with drawings, files, versions, project memory, tasks and approval in the inbox',
              b: 'Conversations; in ChatGPT Business, according to OpenAI, company knowledge such as SharePoint and Google Drive can be connected, with links back to the source',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to OpenAI: Business and Enterprise not used for training by default; Free and Plus on by default, can be switched off in settings',
            },
            {
              label: 'Data location',
              a: 'Sign-in through WorkOS (USA), AI requests through OpenRouter (USA) to model providers, some outside the EU; no data-location promise',
              b: 'According to OpenAI, storage in Europe for some business plans, rolled out gradually; covers storage, not processing',
            },
          ],
          note: 'ChatGPT details as stated by OpenAI, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where ChatGPT is ahead',
            items: [
              'Writing. Emails to clients, building descriptions, summaries of long permits or expert reports: ChatGPT writes them quickly and well.',
              'Breadth: spreadsheet formulas, translations, code, far beyond building law.',
              'Ready to use, with public plans.',
              'A company on the market. Piloti is being founded and is in its pilot phase.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'A maintained body of Austrian building law: state building codes from RIS and the OIB guidelines, cited down to section or clause.',
              'State and edition as part of the answer. If the state or the building class is missing, Piloti asks or states its assumption.',
              'The project as the place of work: drawings, tasks, file notes sent for approval, and a memory of what is already settled.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Why good phrasing is not enough',
          body: [
            'A question like “How long may the escape route be here?” has no single answer in Austria. It depends on the state, on the OIB edition that state has declared binding, and on the building class. According to the OIB overview, the 2023 edition applies in whole or in part in Vienna, Carinthia, Lower Austria, Upper Austria and Tyrol, and in the other four states the 2019 edition generally still applies. A general language model does not have this reliably to hand and rarely says which version it assumes.',
            'Then there is the citation. A language model writes sections that sound plausible even when they do not exist in that form. Anyone who does not look the citation up in RIS carries it unchecked into the file note.',
            'More on this in our journal article “ChatGPT for building law? Where it falls short”.',
          ],
        },
        {
          kind: 'text',
          title: 'Data protection in a planning office',
          body: [
            'For the GDPR, the plan counts first. According to OpenAI, ChatGPT Business and Enterprise do not train on your data by default, Free and Plus do, switchable off in settings. Anyone copying drawings or clients’ names into a personal account should know this.',
            'Piloti does not train models on office data and makes no data-location promise; the routes are in the table. Offices can use their own provider key.',
          ],
        },
        {
          kind: 'text',
          title: 'Where Piloti stops',
          body: [
            'Piloti is not a general assistant: for a cover letter or a translation, use ChatGPT. Piloti holds the register of standards, not the ÖNORM texts, and does not do your checking for you. It shows where an answer comes from so that you can check it.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can I use ChatGPT for building law in Austria?',
          a: 'As a starting point, yes; as evidence, no. ChatGPT explains terms well, but has no maintained body of state building codes and OIB guidelines. Look every citation up yourself in RIS or in the OIB guideline.',
        },
        {
          q: 'Is ChatGPT GDPR-compliant for a planning office?',
          a: 'That depends on the plan and on your agreement with OpenAI, not on the tool alone. According to OpenAI, Business and Enterprise data is not used for training by default; on Free and Plus it is, and that can be switched off. The assessment for your office belongs with your data-protection adviser.',
        },
        {
          q: 'Which ChatGPT alternative fits architects in Austria?',
          a: 'It depends on the job. For writing and general questions ChatGPT remains strong. For questions whose answer goes into a submission or a file note, you need a tool with Austrian building law, state logic and checked citations. Piloti is built for that, currently in a pilot phase with selected offices.',
        },
      ],
    },
  },
  {
    slug: 'microsoft-copilot',
    checked: '2026-09',
    related: ['vergleich/chatgpt', 'vergleich/notebooklm', 'anwendungen/bueroarchiv', 'baurecht/wien'],
    de: {
      title: 'Microsoft Copilot für Architekten: Piloti im Vergleich',
      description:
        'Microsoft Copilot oder Piloti im Planungsbüro? Wo Copilot in Microsoft 365 stark ist und wo österreichisches Baurecht, OIB und Freigaben fehlen.',
      heading: 'Microsoft Copilot oder Piloti?',
      lede: 'Viele Büros arbeiten mit Microsoft 365, und Copilot steckt dort schon drin. Die Frage ist, was es für Baurecht und Planung leistet. Hier der Vergleich, zuerst das, was Copilot besser kann.',
      note: 'Gemeint ist Microsoft Copilot, früher Microsoft 365 Copilot. Angaben laut Microsoft (microsoft.com, learn.microsoft.com), gelesen im September 2026.',
      answer:
        'Liegt das Wissen Ihres Büros in SharePoint, Outlook und Teams, findet Copilot es dort, und nur das, was Sie sehen dürfen. Für Fragen zum österreichischen Baurecht bringt es keinen eigenen Bestand an Landesbauordnungen und OIB-Richtlinien mit; dafür ist Piloti gebaut.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Microsoft Copilot',
          rows: [
            {
              label: 'Wofür gebaut',
              a: 'Planungsfragen österreichischer Projekte, belegt, bis zum Aktenvermerk und zur Freigabe',
              b: 'Assistent in Microsoft 365, von Word und Outlook bis Teams',
            },
            {
              label: 'Wissensbasis',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Büroarchiv, Projektdokumente, Web',
              b: 'Daten der Organisation in Microsoft 365 über Microsoft Graph: Dokumente, E-Mails, Kalender, Chats, Besprechungen; Websuche über Bing',
            },
            {
              label: 'Berechtigungen',
              a: 'Aufgaben laufen unter Ihrem Namen und Ihren Rechten; das Büroarchiv sieht kein anderes Büro',
              b: 'Zeigt laut Microsoft nur, was die Person sehen darf',
            },
            {
              label: 'Baurecht',
              a: 'Bundesland und OIB-Ausgabe als Teil der Antwort, Fundstelle bis zum Paragraf oder Punkt',
              b: 'Kein eigener Bestand an österreichischem Baurecht; antwortet aus Ihren Dokumenten und aus dem Web',
            },
            {
              label: 'Genauigkeit',
              a: 'Fundstellen vor dem Anzeigen gegen den Quelltext geprüft',
              b: 'Microsoft schreibt selbst, dass Antworten nicht garantiert zu 100 % sachlich richtig sind',
            },
            {
              label: 'Projektarbeit',
              a: 'Projekte mit Plänen, Fassungen, Projektgedächtnis, Aufgaben und Freigabe im Posteingang',
              b: 'Arbeitet in Ihren Dateien und Anwendungen; Ablage und Freigabe regeln Sie in SharePoint und Teams wie bisher',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut Microsoft kein Training der Basismodelle mit Eingaben, Antworten und über Microsoft Graph abgerufenen Daten',
            },
            {
              label: 'Datenstandort',
              a: 'Anmeldung über WorkOS (USA), KI-Anfragen über OpenRouter (USA) an Modellanbieter, auch außerhalb der EU; kein Versprechen zum Datenstandort',
              b: 'Laut Microsoft Verarbeitung innerhalb der europäischen Datengrenze für Kunden in Europa, mit Ausnahmen für einzelne Modellanbieter',
            },
            {
              label: 'Preis',
              a: 'Noch keine Preisliste; Bedingungen je Pilotbüro',
              b: 'Enterprise: 30 US-Dollar je Nutzer:in und Monat bei jährlicher Zahlung (US-Website); die Business-Variante setzt eine Microsoft-365-Business-Lizenz voraus; Copilot Chat ohne Aufpreis für berechtigte Microsoft-365-Nutzer:innen',
            },
          ],
          note: 'Angaben zu Microsoft Copilot laut Microsoft, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Copilot vorn liegt',
            items: [
              'Das eigene Büro-Wissen, wo es schon liegt. Protokolle, Mails, Besprechungen und Dokumente in Microsoft 365 findet Copilot ohne Umzug.',
              'Eingebaut in Word, Outlook und Teams: Mails zusammenfassen, Besprechungen nachbereiten, Entwürfe schreiben.',
              'Ein großer Anbieter mit offenem Preis. Piloti ist in Gründung und gibt kein Versprechen zum Datenstandort.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Österreichisches Baurecht als eigener Bestand: neun Landesbauordnungen aus dem RIS und die OIB-Richtlinien.',
              'Die Ausgabe, die im Bundesland gilt. Piloti nennt sie, wenn sie den Wert verändert, und fragt nach, wenn Bundesland oder Gebäudeklasse fehlen.',
              'Pläne als Bild: Piloti sieht Grundriss und Schnitt an und markiert, welche Zeichnung auf dem Blatt es gelesen hat.',
              'Ein Ablauf für Planungsfragen: Tiefenrecherche mit Bericht im Projekt, Befunde als offene Punkte, Aktenvermerke mit Freigeben, Änderungen anfordern oder Ablehnen.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Woher Copilot baurechtliche Antworten nimmt',
          body: [
            'Copilot antwortet aus zwei Quellen: aus den Daten Ihrer Organisation und aus dem Web über Bing. Liegt in Ihrem SharePoint die aktuelle Fassung der Bauordnung, findet Copilot sie. Liegt dort eine alte, findet es die alte. Welche OIB-Ausgabe in welchem Bundesland verbindlich ist, entnimmt Copilot keinem gepflegten Bestand, sondern dem, was es gerade findet.',
            'Piloti führt je Bundesland die Landesgesetze aus dem RIS, für Wien etwa auch die Bautechnikverordnung 2023 und die MA 37 Merkblätter, und zitiert so, wie ein Bescheid es tut: „Bauordnung für Wien, § …“. Die Quelle öffnet sich in Piloti an der markierten Stelle.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie beides zusammenpasst, und wo Piloti aufhört',
          body: [
            'Copilot und Piloti schließen einander nicht aus. Für Mails, Besprechungsnotizen und die eigenen Microsoft-365-Dateien ist Copilot das nähere Werkzeug, für die Frage, was ein Projekt in Salzburg oder Tirol erfüllen muss, Piloti.',
            'Piloti ist nicht in Word oder Outlook eingebaut und durchsucht nicht Ihr Microsoft 365. Dokumente kommen durch Hochladen ins Projekt oder ins Büroarchiv, auch als ganzer Ordner. Und Piloti ist ein Proof of Concept in der Pilotphase.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann Microsoft Copilot österreichisches Baurecht?',
          a: 'Copilot hat keinen eigenen Bestand an Landesbauordnungen und OIB-Richtlinien. Es antwortet aus Ihren Dateien in Microsoft 365 und aus dem Web über Bing, also so gut wie die Fassungen, die es dort findet.',
        },
        {
          q: 'Was kostet Microsoft Copilot?',
          a: 'Microsoft nennt auf seiner US-Website für die Enterprise-Variante 30 US-Dollar je Nutzer:in und Monat bei jährlicher Zahlung; Copilot Chat ist für berechtigte Microsoft-365-Nutzer:innen ohne Aufpreis enthalten. Piloti hat noch keine Preisliste; in der Pilotphase werden die Bedingungen je Büro vereinbart.',
        },
        {
          q: 'Trainiert Microsoft mit den Daten aus Copilot?',
          a: 'Laut Microsoft werden Eingaben, Antworten und über Microsoft Graph abgerufene Daten nicht zum Training der Basismodelle verwendet. Piloti trainiert ebenfalls keine Modelle mit Büro-Daten.',
        },
        {
          q: 'Wo verarbeitet Copilot die Daten?',
          a: 'Microsoft verarbeitet Copilot-Daten europäischer Kunden laut eigener Angabe innerhalb seiner europäischen Datengrenze, mit Ausnahmen für einzelne Modellanbieter. Bei Piloti läuft die Anmeldung über WorkOS (USA), KI-Anfragen gehen über OpenRouter (USA) an Modellanbieter, die auch außerhalb der EU sitzen können.',
        },
      ],
    },
    en: {
      title: 'Microsoft Copilot for architects: Piloti compared',
      description:
        'Microsoft Copilot or Piloti in a planning office? Where Copilot is strong in Microsoft 365, and where Austrian building law, OIB and approvals are missing.',
      heading: 'Microsoft Copilot or Piloti?',
      lede: 'Many offices work in Microsoft 365, and Copilot is already built in there. The question is what it does for building law and planning. Here is the comparison, starting with what Copilot does better.',
      note: 'This means Microsoft Copilot, formerly Microsoft 365 Copilot. Details as stated by Microsoft (microsoft.com, learn.microsoft.com), read in September 2026.',
      answer:
        'If your office’s knowledge lives in SharePoint, Outlook and Teams, Copilot finds it there, and only what you are allowed to see. For questions on Austrian building law it brings no body of state building codes and OIB guidelines of its own; that is what Piloti is built for.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Microsoft Copilot',
          rows: [
            {
              label: 'Built for',
              a: 'Planning questions on Austrian projects, with evidence, through to the file note and approval',
              b: 'Assistant in Microsoft 365, from Word and Outlook to Teams',
            },
            {
              label: 'Knowledge base',
              a: 'State law from RIS, OIB guidelines, register of standards, office archive, project documents, web',
              b: 'The organisation’s Microsoft 365 data via Microsoft Graph: documents, email, calendar, chats, meetings; web search via Bing',
            },
            {
              label: 'Permissions',
              a: 'Tasks run under your name and your permissions; no other office sees the office archive',
              b: 'According to Microsoft, shows only what the user has permission to see',
            },
            {
              label: 'Building law',
              a: 'State and OIB edition as part of the answer, citation down to section or clause',
              b: 'No body of Austrian building law of its own; answers from your documents and the web',
            },
            {
              label: 'Accuracy',
              a: 'Citations checked against the source text before they are shown',
              b: 'Microsoft itself says responses aren’t guaranteed to be 100 % factual',
            },
            {
              label: 'Project work',
              a: 'Projects with drawings, versions, project memory, tasks and approval in the inbox',
              b: 'Works in your files and apps; filing and approval stay in SharePoint and Teams as before',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to Microsoft, prompts, responses and data accessed through Microsoft Graph aren’t used to train foundation models',
            },
            {
              label: 'Data location',
              a: 'Sign-in through WorkOS (USA), AI requests through OpenRouter (USA) to model providers, some outside the EU; no data-location promise',
              b: 'According to Microsoft, processed within its European data boundary for customers in Europe, with exceptions for individual model providers',
            },
            {
              label: 'Price',
              a: 'No price list yet; terms agreed with each pilot office',
              b: 'Enterprise: $30 per user per month, paid yearly (US website); the Business variant requires a Microsoft 365 Business licence; Copilot Chat at no extra cost for eligible Microsoft 365 users',
            },
          ],
          note: 'Microsoft Copilot details as stated by Microsoft, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where Copilot is ahead',
            items: [
              'Your office’s own knowledge, where it already lives. Copilot finds minutes, emails, meetings and documents in Microsoft 365 without moving anything.',
              'Built into Word, Outlook and Teams: summarising emails, following up meetings, writing drafts.',
              'A large vendor with a public price. Piloti is being founded and makes no data-location promise.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'Austrian building law as its own body of sources: nine state building codes from RIS and the OIB guidelines.',
              'The edition in force in the state. Piloti names it when it changes the value, and asks when the state or building class is missing.',
              'Drawings as images: Piloti looks at plan and section and marks which drawing on the sheet it read.',
              'A workflow for planning questions: in-depth research with a report in the project, findings as open points, file notes with Approve, Request changes or Reject.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Where Copilot’s building-law answers come from',
          body: [
            'Copilot answers from two sources: your organisation’s data and the web via Bing. If your SharePoint holds the current version of the building code, Copilot finds it. If it holds an old one, it finds the old one. Which OIB edition is binding in which state is not taken from a maintained register but from whatever it happens to find.',
            'Piloti holds each state’s laws from RIS, for Vienna also the Building Technology Ordinance 2023 and the MA 37 guidance sheets, and cites them the way an official decision does: “Bauordnung für Wien, § …”. The source opens inside Piloti at the marked passage.',
          ],
        },
        {
          kind: 'text',
          title: 'How the two fit together, and where Piloti stops',
          body: [
            'Copilot and Piloti do not exclude each other. For emails, meeting notes and your own Microsoft 365 files, Copilot is the closer tool; for what a project in Salzburg or Tyrol must meet, Piloti.',
            'Piloti is not built into Word or Outlook and does not search your Microsoft 365. Documents come in by upload to the project or the office archive, including whole folders. And Piloti is a proof of concept in a pilot phase.',
          ],
        },
      ],
      faq: [
        {
          q: 'Does Microsoft Copilot handle Austrian building law?',
          a: 'Copilot has no body of state building codes and OIB guidelines of its own. It answers from your files in Microsoft 365 and from the web via Bing, so it is as good as the versions it finds there.',
        },
        {
          q: 'What does Microsoft Copilot cost?',
          a: 'On its US website, Microsoft lists $30 per user per month, paid yearly, for the Enterprise variant; Copilot Chat is included at no extra cost for eligible Microsoft 365 users. Piloti has no price list yet; during the pilot phase terms are agreed with each office.',
        },
        {
          q: 'Does Microsoft train on Copilot data?',
          a: 'According to Microsoft, prompts, responses and data accessed through Microsoft Graph are not used to train foundation models. Piloti does not train models on office data either.',
        },
        {
          q: 'Where does Copilot process data?',
          a: 'Microsoft says it processes Copilot data of European customers within its European data boundary, with exceptions for individual model providers. With Piloti, sign-in runs through WorkOS (USA) and AI requests go through OpenRouter (USA) to model providers that may be based outside the EU.',
        },
      ],
    },
  },
  {
    slug: 'notebooklm',
    checked: '2026-09',
    related: ['vergleich/chatgpt', 'vergleich/ris-und-google', 'glossar/oib-richtlinien', 'anwendungen/bueroarchiv'],
    de: {
      title: 'NotebookLM (Gemini Notebook) für Baurecht: Vergleich',
      description:
        'NotebookLM (Gemini Notebook) oder Piloti für Baurecht in Österreich? Eigene Quellen mit Zitaten gegen gepflegte Landesbauordnungen und OIB-Richtlinien.',
      heading: 'NotebookLM oder Piloti?',
      lede: 'NotebookLM, das Google inzwischen Gemini Notebook nennt, beantwortet Fragen aus den Quellen, die Sie selbst hinzufügen. Das ist nah an dem, was ein Planungsbüro braucht. Der Unterschied liegt darin, wer die Quellen sammelt und aktuell hält.',
      note: 'Angaben zu NotebookLM (Gemini Notebook) laut Google, gelesen im September 2026.',
      answer:
        'NotebookLM (Gemini Notebook) antwortet mit Zitaten aus Quellen, die Sie selbst sammeln und aktuell halten. Piloti bringt die neun Landesbauordnungen aus dem RIS und die OIB-Richtlinien mit, zieht die Ausgabe heran, die im Bundesland gilt, und bettet die Antwort in die Projektarbeit ein.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'NotebookLM (Gemini Notebook)',
          rows: [
            {
              label: 'Prinzip',
              a: 'Gepflegter Bestand an österreichischem Baurecht, dazu Ihr Büroarchiv und Ihre Projektdokumente',
              b: 'Antworten auf Grundlage der Quellen, die Sie in ein Notizbuch geben',
            },
            {
              label: 'Quellen',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze; Uploads als PDF, Word, Excel, PowerPoint, CSV, Bild oder ganzer Ordner',
              b: 'PDFs, Websites, YouTube, Audio, Google Docs und Slides; bis 500.000 Wörter oder 200 MB je Quelle',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Zieht die Gesetze des Bundeslands heran und nennt die OIB-Ausgabe, die dort gilt',
              b: 'Sie entscheiden, welche Fassung Sie hinzufügen; bis 50 Quellen je Notizbuch im kostenlosen Tarif, 100 bis 600 in höheren',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis Paragraf, Punkt oder Seite, vor dem Anzeigen gegen den Quelltext geprüft',
              b: 'Zitate im Text, die auf die Stelle in Ihrer Quelle verweisen',
            },
            {
              label: 'Zusammenarbeit',
              a: 'Projekte mit Fassungen, Aufgaben, Projektgedächtnis und Freigabe im Posteingang',
              b: 'Notizbücher lassen sich teilen',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut Google werden hochgeladene Daten nie zum Training verwendet',
            },
            {
              label: 'Verfügbarkeit',
              a: 'Proof of Concept mit ausgewählten Pilotbüros',
              b: 'Kostenloser Einstieg, in Google-Workspace-Tarifen enthalten',
            },
          ],
          note: 'Angaben zu NotebookLM (Gemini Notebook) laut Google, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo NotebookLM vorn liegt',
            items: [
              'Sie bestimmen die Quellen. Die Antwort stützt sich auf das, was Sie ausgewählt haben.',
              'Viele Formate, auch Video und Audio, etwa die Aufzeichnung eines Vortrags zu einer Novelle.',
              'Sofort nutzbar, kostenlos oder in Google Workspace enthalten, ohne Gespräch.',
              'Ein großer Anbieter am Markt. Piloti ist in Gründung und in der Pilotphase.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Die Quellen sind schon da: neun Landesbauordnungen und verwandtes Landesrecht aus dem RIS, OIB-Richtlinien, für Wien auch Bautechnikverordnung 2023, Garagengesetz 2008 und MA 37 Merkblätter.',
              'Die Ausgabe folgt dem Bundesland. Laut OIB-Übersicht gilt die Ausgabe 2023 nicht überall; Piloti nennt, welche es heranzieht, wenn sie den Wert verändert.',
              'Rückfragen bei fehlenden Fakten: Fehlt die Gebäudeklasse oder das Bundesland, fragt Piloti nach oder nennt die Annahme.',
              'Fragen werden zu Arbeit im Projekt: Aufgaben, Tiefenrecherche mit Bericht, Aktenvermerk zur Freigabe.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Was ein Baurechts-Notizbuch an Pflege braucht',
          body: [
            'Wer NotebookLM für Baurecht nutzt, baut sein eigenes Regelwerk: die OIB-Richtlinien in der Ausgabe, die im Bundesland gilt, die Bauordnung und die Bautechnikvorschriften jedes Landes, in dem das Büro plant, dazu Merkblätter. In Wien sind das die Bauordnung für Wien und die Wiener Bautechnikverordnung 2023, in Salzburg das Bautechnikgesetz 2015 und das Baupolizeigesetz 1997, in Tirol die Tiroler Bauordnung 2022. Neun Bundesländer, neun Sammlungen.',
            'Dann beginnt die Pflege. Laut OIB-Übersicht ist die OIB-Richtlinie 6 in der Ausgabe 2025 bisher nur in Tirol und Wien in Kraft, die Ausgabe 2027 wird vorbereitet, und Landesgesetze werden novelliert. Jede neue Fassung muss jemand im Büro bemerken, hinzufügen und die alte aus dem Notizbuch nehmen. Übersieht man das, zitiert das Notizbuch sauber aus einer veralteten Quelle.',
          ],
        },
        {
          kind: 'text',
          title: 'Wo Piloti aufhört',
          body: [
            'Piloti führt das Normenverzeichnis, nicht die ÖNORM-Texte; wer mit Normtexten arbeiten will, lädt die lizenzierten Dokumente selbst ins Projekt. Was der Bebauungsplan für ein bestimmtes Grundstück festlegt, sieht Piloti nur, wenn der Plan im Projekt liegt; sonst sagt es, wo Sie nachsehen.',
            'Für eine Sammlung, die nicht Baurecht ist, etwa Wettbewerbsunterlagen, Fachvorträge oder die Literatur zu einem Entwurfsthema, ist ein Notizbuch in NotebookLM ein gutes Werkzeug.',
          ],
        },
      ],
      faq: [
        {
          q: 'Ist NotebookLM dasselbe wie Gemini Notebook?',
          a: 'Ja. Google führt NotebookLM inzwischen unter dem Namen Gemini Notebook. Das Prinzip: Antworten auf Grundlage der Quellen, die Sie in ein Notizbuch geben, mit Zitaten im Text.',
        },
        {
          q: 'Kann ich die OIB-Richtlinien in NotebookLM hochladen?',
          a: 'Ja, als PDF wie jedes andere Dokument. Sie wählen dann selbst die Ausgabe, die im Bundesland Ihres Projekts gilt, und tauschen sie aus, wenn sich das ändert. Laut OIB-Übersicht gilt die Ausgabe 2023 nicht in allen Bundesländern; maßgeblich ist die Bautechnikverordnung oder das Gesetz des Landes.',
        },
        {
          q: 'Wie viele Quellen passen in ein Notizbuch?',
          a: 'Laut Google bis 50 Quellen je Notizbuch im kostenlosen Tarif und 100 bis 600 in höheren Tarifen, jede bis 500.000 Wörter oder 200 MB. Beim Baurecht ist selten die Menge die Grenze, eher die Pflege: welche Fassung gerade gilt.',
        },
        {
          q: 'Verwendet Google meine Dokumente zum Training?',
          a: 'Laut Google werden hochgeladene Daten nie zum Training verwendet. Auch Piloti trainiert keine Modelle mit Büro-Daten.',
        },
      ],
    },
    en: {
      title: 'NotebookLM (Gemini Notebook) for building law: compared',
      description:
        'NotebookLM (Gemini Notebook) or Piloti for Austrian building law? Your own sources with citations, or maintained state building codes and OIB guidelines.',
      heading: 'NotebookLM or Piloti?',
      lede: 'NotebookLM, which Google now calls Gemini Notebook, answers questions from the sources you add yourself. That is close to what a planning office needs. The difference lies in who collects the sources and keeps them current.',
      note: 'NotebookLM (Gemini Notebook) details as stated by Google, read in September 2026.',
      answer:
        'NotebookLM (Gemini Notebook) answers with citations from sources you collect and keep current yourself. Piloti brings the nine state building codes from RIS and the OIB guidelines, draws on the edition in force in the state, and places the answer in the project work.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'NotebookLM (Gemini Notebook)',
          rows: [
            {
              label: 'Principle',
              a: 'Maintained body of Austrian building law, plus your office archive and your project documents',
              b: 'Answers grounded in the sources you add to a notebook',
            },
            {
              label: 'Sources',
              a: 'State law from RIS, OIB guidelines, register of standards, federal law; uploads as PDF, Word, Excel, PowerPoint, CSV, image or whole folder',
              b: 'PDFs, websites, YouTube, audio, Google Docs and Slides; up to 500,000 words or 200 MB per source',
            },
            {
              label: 'State and edition',
              a: 'Draws on the state’s laws and names the OIB edition in force there',
              b: 'You decide which version you add; up to 50 sources per notebook on the free plan, 100 to 600 on higher plans',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section, clause or page, checked against the source text before it is shown',
              b: 'Inline citations pointing to the passage in your source',
            },
            {
              label: 'Collaboration',
              a: 'Projects with versions, tasks, project memory and approval in the inbox',
              b: 'Notebooks can be shared',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to Google, uploaded data is never used for training',
            },
            {
              label: 'Availability',
              a: 'Proof of concept with selected pilot offices',
              b: 'Free entry, included in Google Workspace plans',
            },
          ],
          note: 'NotebookLM (Gemini Notebook) details as stated by Google, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where NotebookLM is ahead',
            items: [
              'You choose the sources. The answer rests on what you selected.',
              'Many formats, including video and audio, such as the recording of a talk on an amendment.',
              'Ready to use, free or included in Google Workspace, without a conversation.',
              'A large vendor on the market. Piloti is being founded and is in its pilot phase.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'The sources are already there: nine state building codes and related state law from RIS, the OIB guidelines, and for Vienna also the Building Technology Ordinance 2023, the Garage Act 2008 and the MA 37 guidance sheets.',
              'The edition follows the state. According to the OIB overview the 2023 edition does not apply everywhere; Piloti names which one it draws on when it changes the value.',
              'Questions back when facts are missing: if the building class or the state is missing, Piloti asks or states its assumption.',
              'Questions become work in the project: tasks, in-depth research with a report, a file note sent for approval.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'What a building-law notebook takes to maintain',
          body: [
            'Using NotebookLM for building law means building your own rulebook: the OIB guidelines in the edition in force in the state, the building code and building-technology rules of every state the office plans in, and guidance sheets. In Vienna that is the Bauordnung für Wien and the Wiener Bautechnikverordnung 2023, in Salzburg the Bautechnikgesetz 2015 and the Baupolizeigesetz 1997, in Tyrol the Tiroler Bauordnung 2022. Nine states, nine collections.',
            'Then the maintenance starts. According to the OIB overview, the 2025 edition of OIB guideline 6 is so far in force only in Tyrol and Vienna, the 2027 edition is being prepared, and state laws are amended. Someone in the office has to notice each new version, add it and take the old one out of the notebook. Miss that, and the notebook cites cleanly from an outdated source.',
          ],
        },
        {
          kind: 'text',
          title: 'Where Piloti stops',
          body: [
            'Piloti holds the register of standards, not the ÖNORM texts; if you want to work with standard texts, upload your licensed copies to the project. What the zoning plan fixes for a specific plot Piloti sees only if the plan is in the project; otherwise it tells you where to look.',
            'For a collection that is not building law, such as competition documents, lectures or the literature on a design topic, a notebook in NotebookLM is a good tool.',
          ],
        },
      ],
      faq: [
        {
          q: 'Is NotebookLM the same as Gemini Notebook?',
          a: 'Yes. Google now offers NotebookLM under the name Gemini Notebook. The principle: answers grounded in the sources you add to a notebook, with inline citations.',
        },
        {
          q: 'Can I upload the OIB guidelines to NotebookLM?',
          a: 'Yes, as a PDF like any other document. You then choose the edition in force in your project’s state yourself, and replace it when that changes. According to the OIB overview, the 2023 edition does not apply in every state; what counts is the state’s building-technology ordinance or law.',
        },
        {
          q: 'How many sources fit in a notebook?',
          a: 'According to Google, up to 50 sources per notebook on the free plan and 100 to 600 on higher plans, each up to 500,000 words or 200 MB. For building law the limit is rarely the quantity, rather the upkeep: which version currently applies.',
        },
        {
          q: 'Does Google use my documents for training?',
          a: 'According to Google, uploaded data is never used for training. Piloti does not train models on office data either.',
        },
      ],
    },
  },
  {
    slug: 'perplexity',
    checked: '2026-09',
    related: ['vergleich/chatgpt', 'vergleich/ris-und-google', 'glossar/ris', 'baurecht/wien'],
    de: {
      title: 'Perplexity für Baurecht in Österreich? Piloti im Vergleich',
      description:
        'Perplexity oder Piloti für Baurecht? Websuche mit Quellen gegen Landesbauordnungen aus dem RIS und OIB-Richtlinien, mit Bundesland, Ausgabe und Projekt.',
      heading: 'Perplexity oder Piloti?',
      lede: 'Perplexity sucht im Web und nennt zu jeder Antwort die Quellen. Für aktuelle Recherche ist das stark. Beim Baurecht kommt es darauf an, welche Quelle das Web gerade liefert.',
      note: 'Angaben zu Perplexity laut Perplexity (perplexity.ai), gelesen im September 2026. Preise nennen wir nicht, weil sie je Tarif wechseln.',
      answer:
        'Perplexity beantwortet Fragen aus dem offenen Web und verlinkt die Quellen, gut für aktuelle Recherche. Für Baurecht in Österreich fehlt ihm die Logik, welches Landesgesetz und welche OIB-Ausgabe im Bundesland des Projekts gilt; Piloti arbeitet mit diesem Bestand und im Projekt.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Perplexity',
          rows: [
            {
              label: 'Prinzip',
              a: 'Gepflegter Bestand an österreichischem Baurecht, dazu Büroarchiv, Projektdokumente und Websuche',
              b: 'Antworten aus dem Web, mit Quellen zu jeder Antwort',
            },
            {
              label: 'Quellen',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Bundesgesetze wie ASchG, UVP-G und Gewerbeordnung',
              b: 'Offenes Web; in Spaces zusätzlich eigene Dateien',
            },
            {
              label: 'Websuche',
              a: 'Ja, jede Quelle verlinkt, neben dem gepflegten Bestand',
              b: 'Kern des Produkts',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Zieht die Gesetze des Bundeslands heran und nennt die OIB-Ausgabe, die dort gilt',
              b: 'Hängt davon ab, welche Seiten die Suche findet und ob Sie beides in der Frage angeben',
            },
            {
              label: 'Belege',
              a: 'Fundstelle bis Paragraf, Punkt oder Seite, gegen den Quelltext geprüft; RIS-Quellen öffnen an der markierten Stelle',
              b: 'Links zu den Webseiten, aus denen die Antwort stammt',
            },
            {
              label: 'Projektarbeit',
              a: 'Projekte mit Plänen, Fassungen, Aufgaben, Projektgedächtnis und Freigabe',
              b: 'Spaces verbinden Websuche und eigene Dateien zu einem Thema',
            },
            {
              label: 'Training',
              a: 'Kein Training mit Büro-Daten',
              b: 'Laut Perplexity: Enterprise-Daten kein Training; in Free und Pro ist die Nutzung zur Verbesserung der Modelle standardmäßig an und abschaltbar',
            },
            { label: 'Stand', a: 'Proof of Concept mit ausgewählten Pilotbüros', b: 'Am Markt' },
          ],
          note: 'Angaben zu Perplexity laut Perplexity, gelesen im September 2026. Stimmt etwas nicht mehr, schreiben Sie uns, und wir korrigieren es.',
        },
        {
          kind: 'split',
          left: {
            title: 'Wo Perplexity vorn liegt',
            items: [
              'Aktuelles aus dem Web: Förderungen, Herstellerangaben, Marktberichte, eine Novelle, über die gerade berichtet wird.',
              'Websuche ist das Kernprodukt, mit Quellen bei jeder Antwort.',
              'Sofort nutzbar, auch im kostenlosen Tarif.',
              'Ein Unternehmen am Markt. Piloti ist in Gründung und in der Pilotphase.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Landesrecht aus dem RIS statt der Seite, die in der Suche oben steht. Piloti zieht die Gesetze des Bundeslands heran, in dem das Projekt liegt.',
              'OIB-Richtlinien mit Punkt und Seite, in der Ausgabe, die dort gilt.',
              'Fundstellen werden gegen den Quelltext geprüft, bevor sie erscheinen.',
              'Das Projekt: Pläne, Aufgaben, Aktenvermerke zur Freigabe und ein Gedächtnis für das schon Geklärte.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Warum das Web beim Baurecht wenig verlässlich ist',
          body: [
            'Baurechtliche Antworten stehen im Web oft in PDFs unterschiedlichen Alters: ein Merkblatt einer Landesregierung, das vor einer Novelle geschrieben wurde, ein Vortrag bei der Kammer, eine Herstellerseite, die OIB-Richtlinie in der Ausgabe 2019 neben der von 2023. Eine Suche ordnet nach Relevanz, nicht danach, welche Fassung heute im Bundesland verbindlich ist.',
            'Dazu kommen neun Bauordnungen. Eine Seite über das Wiener Baurecht beantwortet keine Frage zu einem Projekt in Vorarlberg, auch wenn sie in der Suche oben steht. Perplexity nennt die Quelle; ob sie für Ihr Bundesland und Ihre Ausgabe gilt, prüfen Sie selbst.',
          ],
        },
        {
          kind: 'text',
          title: 'Wo Piloti aufhört',
          body: [
            'Piloti recherchiert ebenfalls im Web und verlinkt jede Quelle, aber die Websuche ist nicht sein Kern. Für breite Marktrecherche, Nachrichten oder Fragen weit außerhalb des Baurechts ist Perplexity das bessere Werkzeug.',
            'Piloti führt das Normenverzeichnis, nicht die ÖNORM-Texte, und rechnet keinen HWB. Es ist ein Proof of Concept in der Pilotphase mit ausgewählten Büros.',
          ],
        },
      ],
      faq: [
        {
          q: 'Kann Perplexity Fragen zum österreichischen Baurecht beantworten?',
          a: 'Es findet dazu Seiten im Web und nennt sie als Quellen. Ob die gefundene Fassung für Ihr Bundesland und die dort geltende OIB-Ausgabe stimmt, entscheidet die Suche nicht. Für eine Antwort, die in eine Einreichung geht, schlagen Sie die Fundstelle im RIS oder in der OIB-Richtlinie nach.',
        },
        {
          q: 'Welche Quellen nutzt Perplexity?',
          a: 'Das offene Web, mit Links zu den Seiten, aus denen die Antwort stammt. In Spaces lassen sich laut Perplexity Websuche und eigene Dateien verbinden. Einen gepflegten Bestand an Landesbauordnungen und OIB-Richtlinien nennt Perplexity nicht.',
        },
        {
          q: 'Verwendet Perplexity meine Fragen zum Training?',
          a: 'Laut Perplexity werden Enterprise-Daten nicht zum Training verwendet. In Free und Pro ist die Speicherung von Daten zur Verbesserung der Modelle standardmäßig an und lässt sich abschalten. Piloti trainiert keine Modelle mit Büro-Daten.',
        },
        {
          q: 'Recherchiert Piloti auch im Web?',
          a: 'Ja. Neben den Landesgesetzen aus dem RIS, den OIB-Richtlinien und Ihren Dokumenten sucht Piloti im Web und verlinkt jede Quelle. In der Antwort sehen Sie, ob eine Aussage aus dem Baurecht, aus Ihrem Büro, aus dem Projekt oder aus dem Web stammt.',
        },
      ],
    },
    en: {
      title: 'Perplexity for Austrian building law? Piloti compared',
      description:
        'Perplexity or Piloti for building law? Web search with sources versus state building codes from RIS and OIB guidelines, with state, edition and project.',
      heading: 'Perplexity or Piloti?',
      lede: 'Perplexity searches the web and names the sources for every answer. For current research that is strong. For building law, it depends on which source the web happens to return.',
      note: 'Perplexity details as stated by Perplexity (perplexity.ai), read in September 2026. We do not list prices, because they vary by plan.',
      answer:
        'Perplexity answers from the open web and links its sources, which is good for current research. For Austrian building law it lacks the logic of which state law and which OIB edition apply in the project’s state; Piloti works with that body of law and inside the project.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Perplexity',
          rows: [
            {
              label: 'Principle',
              a: 'Maintained body of Austrian building law, plus office archive, project documents and web search',
              b: 'Answers from the web, with sources for every answer',
            },
            {
              label: 'Sources',
              a: 'State law from RIS, OIB guidelines, register of standards, federal law such as ASchG, UVP-G and the Trade Act',
              b: 'Open web; in Spaces also your own files',
            },
            {
              label: 'Web search',
              a: 'Yes, every source linked, alongside the maintained body of law',
              b: 'The core of the product',
            },
            {
              label: 'State and edition',
              a: 'Draws on the state’s laws and names the OIB edition in force there',
              b: 'Depends on which pages the search finds and whether your question states both',
            },
            {
              label: 'Evidence',
              a: 'Citation down to section, clause or page, checked against the source text; RIS sources open at the marked passage',
              b: 'Links to the web pages the answer comes from',
            },
            {
              label: 'Project work',
              a: 'Projects with drawings, versions, tasks, project memory and approval',
              b: 'Spaces combine web search and your own files around a topic',
            },
            {
              label: 'Training',
              a: 'No training on office data',
              b: 'According to Perplexity: Enterprise data not used for training; on Free and Pro, use for model improvement is on by default and can be switched off',
            },
            { label: 'Stage', a: 'Proof of concept with selected pilot offices', b: 'On the market' },
          ],
          note: 'Perplexity details as stated by Perplexity, read in September 2026. If something has changed, write to us and we will correct it.',
        },
        {
          kind: 'split',
          left: {
            title: 'Where Perplexity is ahead',
            items: [
              'What is current on the web: subsidies, manufacturer data, market reports, an amendment that is in the news.',
              'Web search is the core product, with sources for every answer.',
              'Ready to use, including on the free plan.',
              'A company on the market. Piloti is being founded and is in its pilot phase.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'State law from RIS instead of whichever page ranks first. Piloti draws on the laws of the state the project is in.',
              'OIB guidelines with clause and page, in the edition in force there.',
              'Citations are checked against the source text before they appear.',
              'The project: drawings, tasks, file notes sent for approval, and a memory of what is already settled.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Why the web is unreliable for building law',
          body: [
            'Building-law answers on the web often sit in PDFs of varying age: a state government guidance sheet written before an amendment, a talk at the chamber, a manufacturer’s page, the 2019 edition of an OIB guideline next to the 2023 one. A search ranks by relevance, not by which version is binding in the state today.',
            'Then there are nine building codes. A page on Vienna’s building law answers no question about a project in Vorarlberg, even if it ranks first. Perplexity names the source; whether it applies to your state and your edition is yours to check.',
          ],
        },
        {
          kind: 'text',
          title: 'Where Piloti stops',
          body: [
            'Piloti also researches the web and links every source, but web search is not its core. For broad market research, news or questions far outside building law, Perplexity is the better tool.',
            'Piloti holds the register of standards, not the ÖNORM texts, and does not calculate an HWB. It is a proof of concept in a pilot phase with selected offices.',
          ],
        },
      ],
      faq: [
        {
          q: 'Can Perplexity answer questions on Austrian building law?',
          a: 'It finds web pages on the topic and names them as sources. Whether the version it found is right for your state and the OIB edition in force there, the search does not decide. For an answer that goes into a submission, look the citation up in RIS or in the OIB guideline.',
        },
        {
          q: 'What sources does Perplexity use?',
          a: 'The open web, with links to the pages the answer comes from. According to Perplexity, Spaces combine web search with your own files. Perplexity does not name a maintained body of state building codes and OIB guidelines.',
        },
        {
          q: 'Does Perplexity use my questions for training?',
          a: 'According to Perplexity, Enterprise data is not used for training. On Free and Pro, data retention for model improvement is on by default and can be switched off. Piloti does not train models on office data.',
        },
        {
          q: 'Does Piloti also research the web?',
          a: 'Yes. Alongside state law from RIS, the OIB guidelines and your documents, Piloti searches the web and links every source. In the answer you see whether a statement comes from building law, from your office, from the project or from the web.',
        },
      ],
    },
  },
  {
    slug: 'ris-und-google',
    checked: '2026-09',
    related: ['glossar/ris', 'glossar/oib-richtlinien', 'baurecht/wien', 'vergleich/perplexity', 'anwendungen/einreichcheck'],
    de: {
      title: 'Baurecht selbst recherchieren: RIS, OIB, Google oder Piloti',
      description:
        'Baurecht selbst recherchieren im RIS, auf der OIB-Website und mit Google, oder mit Piloti? Was die eigene Recherche leistet und wo die Arbeit darin liegt.',
      heading: 'Baurecht selbst recherchieren oder mit Piloti?',
      lede: 'Das RIS ist die amtliche Quelle für Landesrecht, die OIB-Website die für die Richtlinien, beide frei zugänglich. Hier, wo die Arbeit liegt und was Piloti davon übernimmt.',
      note: 'RIS: Rechtsinformationssystem des Bundes (ris.bka.gv.at). OIB: Österreichisches Institut für Bautechnik (oib.or.at). Angaben zu den OIB-Ausgaben laut OIB-Übersicht zum Inkrafttreten.',
      answer:
        'Die eigene Recherche im RIS und auf der OIB-Website bleibt der Maßstab für Richtigkeit. Piloti ersetzt sie nicht, es übernimmt das Zusammensuchen: das Landesgesetz, die geltende OIB-Ausgabe, die Verbindung zu den Plänen des Projekts und die Dokumentation, und es verweist für jede Fundstelle zurück ins RIS.',
      blocks: [
        {
          kind: 'table',
          title: 'Im Detail',
          headA: 'Piloti',
          headB: 'Eigene Recherche (RIS, OIB, Google)',
          rows: [
            {
              label: 'Quellen',
              a: 'Landesrecht aus dem RIS, OIB-Richtlinien, Normenverzeichnis, Büroarchiv, Projektdokumente, Web',
              b: 'RIS für Landes- und Bundesrecht, OIB-Website für die Richtlinien, Google für alles andere',
            },
            {
              label: 'Verbindlichkeit',
              a: 'Zitiert ins RIS und in die OIB-Richtlinie; maßgeblich bleibt der Originaltext',
              b: 'Direkt an der amtlichen Quelle',
            },
            {
              label: 'Bundesland und Ausgabe',
              a: 'Zieht die Gesetze des Bundeslands heran und nennt die OIB-Ausgabe, die dort gilt',
              b: 'Sie suchen die Landesvorschrift und prüfen in der OIB-Übersicht und im Landesrecht, welche Ausgabe gilt',
            },
            {
              label: 'Pläne',
              a: 'Sieht Grundriss und Schnitt als Bild an und markiert die gelesene Zeichnung',
              b: 'Sie legen Plan und Vorschrift selbst nebeneinander',
            },
            {
              label: 'Dokumentation',
              a: 'Antwort mit Begründung, Annahmen und Fundstelle, als Word; Aktenvermerk zur Freigabe',
              b: 'Sie schreiben den Aktenvermerk selbst',
            },
            {
              label: 'Typische Fehler',
              a: 'Ein Sprachmodell kann irren; Fundstellen werden geprüft, die Schlussfolgerung prüfen Sie',
              b: 'Übersehene Novelle, falsches Bundesland, alte Ausgabe aus einem Google-Treffer',
            },
          ],
        },
        {
          kind: 'split',
          left: {
            title: 'Wo die eigene Recherche vorn liegt',
            items: [
              'Sie lesen den Originaltext. Keine Zwischenschicht, kein Modell, das zusammenfasst.',
              'Kostenlos und ohne Anmeldung, im RIS wie auf der OIB-Website.',
              'Sie sehen auch, was neben der gesuchten Bestimmung steht.',
              'Keine Projektdaten an einen Dienst. Wer selbst sucht, lädt keine Pläne hoch.',
            ],
          },
          right: {
            title: 'Wo Piloti vorn liegt',
            items: [
              'Das Zusammensuchen: Piloti holt die einschlägigen Bestimmungen aus dem Landesrecht des Projekts und aus den OIB-Richtlinien zusammen.',
              'Die Ausgabe: Piloti nennt, welche OIB-Ausgabe es heranzieht, wenn sie den Wert verändert.',
              'Die Verbindung zum Projekt: Pläne, Bescheide und frühere Klärungen liegen im selben Projekt wie die Antwort.',
              'Die Dokumentation: Begründung, Annahmen und Fundstelle stehen in der Antwort, als Word herunterladbar oder als Aktenvermerk zur Freigabe.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'Was an der eigenen Recherche Arbeit macht',
          body: [
            'Das RIS beantwortet die Frage, was ein Gesetz sagt, sehr gut. Die Arbeit liegt davor und danach. Davor: herausfinden, welche Vorschrift überhaupt gilt. Eine Frage zum Brandschutz führt in Wien über die Bauordnung für Wien und die Wiener Bautechnikverordnung 2023 zur OIB-Richtlinie 2 in der Ausgabe 2023. In Salzburg führt sie über das Bautechnikgesetz 2015 laut OIB-Übersicht zur Ausgabe 2019, weil Salzburg die Ausgabe 2023 bisher nicht für verbindlich erklärt hat.',
            'Danach: die Bestimmung mit dem Grundriss, der Gebäudeklasse und dem schon Geklärten verbinden und das Ergebnis so festhalten, dass eine Kollegin es in einem Jahr nachvollziehen kann.',
          ],
        },
        {
          kind: 'text',
          title: 'Wie Piloti die eigene Recherche ergänzt, und wo es aufhört',
          body: [
            'Piloti zitiert Landesrecht so, wie ein Bescheid es nennt, und öffnet die RIS-Quelle in Piloti an der markierten Stelle. OIB-Fundstellen tragen Punkt und Seite, etwa „Pkt. 3.5.2 · S. 7“. Der Weg zurück zum Originaltext bleibt damit kurz, und diesen Weg sollten Sie bei jeder Antwort gehen, die in eine Einreichung geht.',
            'Piloti übernimmt nicht Ihre Verantwortung für Auslegung und Abwägung im Einzelfall. Was der Bebauungsplan für ein Grundstück festlegt, sieht es nur, wenn der Plan im Projekt liegt. Es führt das Normenverzeichnis, nicht die ÖNORM-Texte. Und es ist ein Proof of Concept in der Pilotphase mit ausgewählten Büros.',
          ],
        },
      ],
      faq: [
        {
          q: 'Wo finde ich die Bauordnung meines Bundeslands?',
          a: 'Im RIS, dem Rechtsinformationssystem des Bundes, unter dem Landesrecht des jeweiligen Bundeslands. Die Namen unterscheiden sich: In Wien ist es die Bauordnung für Wien, in der Steiermark das Steiermärkische Baugesetz, in Vorarlberg das Baugesetz, in Kärnten die Kärntner Bauordnung 1996. Die technischen Anforderungen stehen oft in einer eigenen Bautechnikvorschrift.',
        },
        {
          q: 'Welche OIB-Richtlinien gelten in meinem Bundesland?',
          a: 'Das OIB veröffentlicht auf seiner Website eine Übersicht, welche Ausgabe in welchem Bundesland in Kraft ist. Laut dieser Übersicht gilt die Ausgabe 2023 in Wien, Kärnten und Niederösterreich für alle sechs Richtlinien, in Oberösterreich und Tirol für die Richtlinien 1 bis 5; in den übrigen Ländern gilt im Allgemeinen noch die Ausgabe 2019. Maßgeblich ist das Landesrecht, das Ausnahmen und Übergänge festlegen kann.',
        },
        {
          q: 'Ist Google für Baurecht verlässlich?',
          a: 'Google findet schnell Merkblätter, Fachartikel und Gesetzestexte, sortiert aber nach Relevanz, nicht nach Geltung. Ein Treffer kann eine alte Fassung, eine andere OIB-Ausgabe oder ein anderes Bundesland betreffen. Die geltende Fassung steht im RIS und auf der OIB-Website.',
        },
        {
          q: 'Brauche ich das RIS noch, wenn ich Piloti nutze?',
          a: 'Ja. Piloti zitiert ins RIS und öffnet die Quelle an der markierten Stelle, damit Sie den Originaltext lesen. Für eine Antwort, die in eine Einreichung oder einen Aktenvermerk geht, bleibt dieser Blick Ihr Teil der Arbeit.',
        },
      ],
    },
    en: {
      title: 'Research building law yourself: RIS, OIB, Google or Piloti',
      description:
        'Research Austrian building law yourself in RIS, on the OIB website and Google, or with Piloti? What your own research delivers, and where the work lies.',
      heading: 'Research building law yourself, or with Piloti?',
      lede: 'RIS is the official source for state law, the OIB website the one for the guidelines, both freely accessible. Here is where the work lies and what Piloti takes on.',
      note: 'RIS: the Austrian federal legal information system (ris.bka.gv.at). OIB: Austrian Institute of Construction Engineering (oib.or.at). OIB editions as stated in the OIB overview of entry into force.',
      answer:
        'Your own research in RIS and on the OIB website remains the benchmark for correctness. Piloti does not replace it; it does the gathering: the state law, the OIB edition in force, the link to the project’s drawings and the documentation, and it points back into RIS for every citation.',
      blocks: [
        {
          kind: 'table',
          title: 'In detail',
          headA: 'Piloti',
          headB: 'Own research (RIS, OIB, Google)',
          rows: [
            {
              label: 'Sources',
              a: 'State law from RIS, OIB guidelines, register of standards, office archive, project documents, web',
              b: 'RIS for state and federal law, the OIB website for the guidelines, Google for everything else',
            },
            {
              label: 'Authority',
              a: 'Cites into RIS and the OIB guideline; the original text remains decisive',
              b: 'Directly at the official source',
            },
            {
              label: 'State and edition',
              a: 'Draws on the state’s laws and names the OIB edition in force there',
              b: 'You find the state rule and check in the OIB overview and the state law which edition applies',
            },
            {
              label: 'Drawings',
              a: 'Looks at plan and section as an image and marks the drawing it read',
              b: 'You put drawing and rule side by side yourself',
            },
            {
              label: 'Documentation',
              a: 'Answer with reasoning, assumptions and citation, as Word; file note sent for approval',
              b: 'You write the file note yourself',
            },
            {
              label: 'Typical errors',
              a: 'A language model can be wrong; citations are checked, the conclusion is yours to check',
              b: 'A missed amendment, the wrong state, an old edition from a Google hit',
            },
          ],
        },
        {
          kind: 'split',
          left: {
            title: 'Where your own research is ahead',
            items: [
              'You read the original text. No intermediate layer, no model summarising.',
              'Free and without sign-in, in RIS as on the OIB website.',
              'You also see what stands next to the provision you were looking for.',
              'No project data sent to a service. Researching yourself means uploading no drawings.',
            ],
          },
          right: {
            title: 'Where Piloti is ahead',
            items: [
              'The gathering: Piloti pulls the relevant provisions together from the project’s state law and the OIB guidelines.',
              'The edition: Piloti names which OIB edition it draws on when it changes the value.',
              'The link to the project: drawings, permits and earlier clarifications sit in the same project as the answer.',
              'The documentation: reasoning, assumptions and citation are in the answer, downloadable as Word or sent as a file note for approval.',
            ],
          },
        },
        {
          kind: 'text',
          title: 'What makes your own research work',
          body: [
            'RIS answers the question of what a law says very well. The work lies before and after. Before: finding out which rule applies at all. A fire-safety question in Vienna leads through the Bauordnung für Wien and the Wiener Bautechnikverordnung 2023 to OIB guideline 2 in the 2023 edition. In Salzburg it leads through the Bautechnikgesetz 2015 to the 2019 edition, according to the OIB overview, because Salzburg has not yet declared the 2023 edition binding.',
            'After: connecting the provision to the floor plan, the building class and what is already settled, and recording the result so that a colleague can follow it a year later.',
          ],
        },
        {
          kind: 'text',
          title: 'How Piloti complements your own research, and where it stops',
          body: [
            'Piloti cites state law the way an official decision does and opens the RIS source inside Piloti at the marked passage. OIB citations carry clause and page, for example “Pkt. 3.5.2 · S. 7”. The way back to the original text stays short, and that is the way to go for every answer that goes into a submission.',
            'Piloti does not take over your responsibility for interpretation and judgement in the individual case. What the zoning plan fixes for a plot it sees only if the plan is in the project. It holds the register of standards, not the ÖNORM texts. And it is a proof of concept in a pilot phase with selected offices.',
          ],
        },
      ],
      faq: [
        {
          q: 'Where do I find my state’s building code?',
          a: 'In RIS, the federal legal information system, under the state law of the state concerned. The names differ: in Vienna it is the Bauordnung für Wien, in Styria the Steiermärkisches Baugesetz, in Vorarlberg the Baugesetz, in Carinthia the Kärntner Bauordnung 1996. The technical requirements are often in a separate building-technology rule.',
        },
        {
          q: 'Which OIB guidelines apply in my state?',
          a: 'The OIB publishes an overview on its website of which edition is in force in which state. According to that overview, the 2023 edition applies in Vienna, Carinthia and Lower Austria for all six guidelines, in Upper Austria and Tyrol for guidelines 1 to 5; in the other states the 2019 edition generally still applies. The state law is decisive and can set exceptions and transitions.',
        },
        {
          q: 'Is Google reliable for building law?',
          a: 'Google quickly finds guidance sheets, articles and legal texts, but ranks by relevance, not by validity. A hit can concern an old version, another OIB edition or another state. The version in force is in RIS and on the OIB website.',
        },
        {
          q: 'Do I still need RIS if I use Piloti?',
          a: 'Yes. Piloti cites into RIS and opens the source at the marked passage so that you read the original text. For an answer that goes into a submission or a file note, that look remains your part of the work.',
        },
      ],
    },
  },
]
