/**
 * The copy of the prose pages: /warum-piloti/, the argument page, and
 * /e-mail-eingang/, how the project mail inbox works. Kept out of ui.ts
 * because they are pages of prose, not interface strings; their titles and
 * descriptions stay in ui.ts `seo.pages` with every other page's. The
 * comparisons are search pages now (src/data/landing/vergleich.ts).
 *
 * Same rules as ui.ts: both locales, German typography, and only what the
 * product does (each capability below shipped and is in the changelog). The
 * typography and claims lints read this file.
 */
import type { Locale } from './ui'

interface Row {
  label: string
  a: string
  b: string
}

const de = {
  why: {
    heading: 'Warum Piloti? Weil es nicht nachschlägt, sondern mitarbeitet.',
    lede: 'Die Stelle im Gesetz, der Plan von 2019, die Auflage vom Amt: Piloti findet sie, mit Quellen, die Sie am Original prüfen. Und dann macht es weiter, bis die Entscheidung im Akt steht.',
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
      title: 'Worauf Sie sich verlassen können',
      items: [
        'Jede Antwort bringt ihre Quellen mit, bis auf Paragraf, Punkt oder Seite. Sie prüfen am Original, bevor etwas in die Einreichung geht; die Verantwortung für die Planung bleibt, wo sie hingehört, bei Ihnen.',
        'Ihre Daten bleiben Ihre: Wir trainieren keine Modelle damit, Pläne und Projekte bleiben Eigentum Ihres Büros, und das Archiv Ihres Büros sieht kein anderes Büro.',
        'Sie bauen mit: Pilotbüros bekommen früh Zugang, einen direkten Draht zu uns Gründern und bestimmen mit, was wir als Nächstes bauen.',
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
      body: 'Sie prüfen gerade mehrere KI-Werkzeuge für Ihr Büro? Piloti neben ChatGPT, Copilot, NotebookLM, Reiner AI und BaurechtGPT, verglichen, und warum Piloti für Planungsfragen in Österreich die bessere Wahl ist.',
      link: 'Alle Vergleiche',
    },
  },
  // /e-mail-eingang/ (MAIL_INBOX_PATH in consts.ts): how the project mail
  // inbox works, for the people who use it and for whoever a mail bounced
  // on. Every rule here is one the receiving side enforces
  // (docs/user-guides/project-mail-inbox.md, ADR-0074); `backticks` render
  // as code.
  mailInbox: {
    heading: 'E-Mail-Eingang: Dateien per E-Mail ins Projekt',
    lede: 'Jedes Projekt in Piloti hat eine eigene E-Mail-Adresse. Senden Sie Pläne, Bescheide oder Stellungnahmen als Anhang dorthin, und Piloti legt die Dateien im Projekt ab, als hätten Sie sie selbst hochgeladen. Aus Outlook speichern und wieder hineinziehen entfällt.',
    address: {
      label: 'So sieht eine Projektadresse aus',
      example: 'wohnbau-hietzing.k3m7q2xw4pab@…',
      note: 'Vor dem Punkt steht der Projektname, damit Sie die Adresse wiedererkennen. Nur die zwölf Zeichen danach bestimmen das Projekt, darum behält ein umbenanntes Projekt seine Adresse. Die Domain nach dem @ ist eine eigene Eingangsdomain, die Ihre Piloti-Installation festlegt.',
    },
    steps: {
      title: 'So funktioniert es',
      items: [
        {
          name: 'Adresse kopieren',
          body: 'Öffnen Sie die Einstellungen des Projekts, Abschnitt „E-Mail-Eingang“. Dort steht die Projektadresse mit einer Schaltfläche zum Kopieren. Legen Sie sie am besten als Kontakt in Ihrem E-Mail-Programm an.',
        },
        {
          name: 'Dateien senden',
          body: 'Senden Sie die Dateien als Anhang, und zwar von der Adresse, mit der Sie sich bei Piloti anmelden. Eine E-Mail vom Fachplaner oder von der Behörde leiten Sie an die Projektadresse weiter.',
        },
        {
          name: 'Im Projekt weiterarbeiten',
          body: 'Jede E-Mail bekommt einen eigenen Ordner unter `E-Mail-Eingang`, benannt nach Datum, Betreff und Absender, etwa `E-Mail-Eingang/2026-09-30 Einreichplan Rev C – Anna Berger`. Sind die Dateien abgelegt, meldet Piloti das in Ihrem Postfach in der App.',
        },
      ],
      missing:
        'Sehen Sie den Abschnitt „E-Mail-Eingang“ nicht, dürfen Sie in diesem Projekt keine Dokumente hinzufügen, oder der E-Mail-Eingang ist in Ihrer Installation nicht eingerichtet. Dann hilft Ihre Administration weiter.',
    },
    files: {
      title: 'Was mit den Anhängen passiert',
      items: [
        'Jeder Anhang wird ein Dokument im Projekt, genau wie ein Upload: durchsuchbar, von Piloti in Antworten zitierbar und mit Fassungen.',
        'Die Dateien zählen zum Speicherkontingent Ihrer Organisation.',
        'Es gelten dieselben Dateitypen und Größen wie beim Hochladen. Passt eine Datei nicht oder ist das Kontingent voll, wird nur diese Datei übersprungen; die übrigen Anhänge werden trotzdem abgelegt.',
        'Übersprungen werden auch Signaturbilder (kleine eingebettete Bilder), leere Anhänge und `winmail.dat` aus Outlook. Für den Inhalt einer `winmail.dat` stellen Sie Outlook auf HTML oder Nur-Text und senden erneut.',
        'Stellt ein Mailserver dieselbe E-Mail zweimal zu, legt Piloti sie einmal ab.',
      ],
    },
    senders: {
      title: 'Wer senden kann',
      body: [
        'Nur Mitglieder der Organisation, die im jeweiligen Projekt Dokumente hinzufügen dürfen. Piloti vergleicht die Absenderadresse mit den Mitgliedern der Organisation, der das Projekt gehört. Senden Sie deshalb von der Adresse, mit der Sie sich anmelden.',
        'Bauherrschaft, Fachplaner und Behörden können noch nicht direkt an die Projektadresse senden. Leiten Sie deren E-Mails selbst weiter.',
      ],
    },
    verify: {
      title: 'Die Domain des Absenders muss prüfbar sein',
      body: [
        'Piloti nimmt eine E-Mail nur an, wenn sie nachweislich von Ihrer Domain kommt: Sie trägt eine gültige DKIM-Signatur der Domain in Ihrer Absenderadresse, oder Ihre Domain veröffentlicht eine DMARC-Richtlinie mit `quarantine` oder `reject`. Sonst könnte jeder Ihre Adresse in die Absenderzeile schreiben, und die E-Mail wird abgelehnt.',
        'Am häufigsten betrifft das Microsoft 365: Solange Ihre IT DKIM nicht für die eigene Domain eingerichtet hat, signiert Microsoft Ihre E-Mails mit `ihrbuero.onmicrosoft.com` statt mit der Domain Ihrer Absenderadresse.',
      ],
      fixTitle: 'So schaltet Ihre IT DKIM ein',
      fixes: [
        {
          name: 'Microsoft 365',
          body: 'Im Microsoft Defender-Portal unter Email & collaboration → Policies & rules → Threat policies → Email authentication settings → DKIM die Domain wählen, die zwei angezeigten CNAME-Einträge im DNS veröffentlichen und die Signatur einschalten.',
        },
        {
          name: 'Google Workspace',
          body: 'In der Admin-Konsole unter Apps → Google Workspace → Gmail → Authenticate email den Schlüssel erzeugen, den TXT-Eintrag im DNS veröffentlichen und die Authentifizierung starten.',
        },
      ],
      fixNote: 'Menünamen aus der englischen Oberfläche. Bis DKIM läuft, laden Sie die Dateien in der App hoch.',
    },
    bounce: {
      title: 'Warum eine E-Mail zurückkommt',
      body: 'Eine abgelehnte E-Mail kommt mit einem allgemeinen Hinweis zurück: Die Adresse ist unbekannt, oder der Absender ist nicht berechtigt oder nicht prüfbar. Der Hinweis ist für jeden Grund derselbe, damit niemand ausprobieren kann, welche Adressen es gibt oder wer Mitglied ist. Der Grund ist einer von diesen:',
      reasons: [
        {
          name: 'Die Adresse ist vertippt oder wurde durch eine neue ersetzt.',
          body: 'Kopieren Sie die aktuelle Adresse aus den Projekteinstellungen.',
        },
        {
          name: 'Sie sind nicht Mitglied des Projekts.',
          body: 'Bitten Sie, wer das Projekt verwaltet, Sie hinzuzufügen.',
        },
        {
          name: 'Sie sind Mitglied, dürfen aber keine Dokumente hinzufügen.',
          body: 'Bitten Sie um eine Rolle, die Dokumente bearbeiten darf.',
        },
        {
          name: 'Sie haben von einer anderen Adresse gesendet als der Ihres Piloti-Kontos.',
          body: 'Senden Sie von der Adresse, mit der Sie sich anmelden.',
        },
        {
          name: 'Ihre Domain ist nicht prüfbar.',
          body: 'Lassen Sie DKIM einschalten, wie oben beschrieben, oder laden Sie die Dateien in der App hoch.',
        },
      ],
    },
    limits: {
      title: 'Grenzen',
      items: [
        'Höchstens 25 MB pro E-Mail, Anhänge eingerechnet. Größere E-Mails lehnt der Mailserver ab, bevor Piloti sie sieht.',
        'Höchstens 60 E-Mails pro Stunde je Projektadresse. Was darüber hinausgeht, geht nicht verloren: Ihr Mailserver stellt es später erneut zu.',
      ],
    },
    privacy: {
      title: 'Datenschutz',
      items: [
        'Der Text der E-Mail wird nicht gespeichert, nur die Anhänge. Kommt es auf den Text an, speichern Sie ihn als PDF und hängen Sie ihn an.',
        'Der Betreff steht im Namen des Ordners. Nennt er eine Person, bleibt er dort, bis Sie den Ordner umbenennen oder löschen.',
        'Empfangen wird die E-Mail über Cloudflare, Inc. (USA), das sie an Piloti weiterreicht. Cloudflare speichert die E-Mail nicht, sondern führt nur ein Zustellprotokoll mit Absender, Empfänger, Betreff und Status. Verarbeitet wird sie im Rechenzentrum nahe dem Absender, das auch außerhalb der EU liegen kann. Cloudflare steht in der Liste der Unterauftragsverarbeiter der Piloti-Anwendung.',
        'Sind die Dateien abgelegt, gilt für sie dasselbe wie für jeden Upload.',
      ],
    },
    rotate: {
      title: 'Eine neue Adresse erzeugen',
      body: [
        'Ist die Adresse bei jemandem gelandet, der sie nicht haben soll, erzeugt, wer das Projekt verwaltet, in den Projekteinstellungen unter „E-Mail-Eingang“ mit „Neue Adresse erzeugen“ eine neue. Die alte funktioniert ab sofort nicht mehr, E-Mails an sie kommen zurück. Geben Sie die neue Adresse allen, die Dateien an das Projekt senden.',
        'Eine bekannt gewordene Adresse allein erlaubt niemandem, etwas abzulegen: Der Absender muss weiterhin ein geprüftes Mitglied mit Schreibrecht sein.',
      ],
    },
  },
}

const en: typeof de = {
  why: {
    heading: 'Why Piloti? Because it does not just look things up. It works alongside you.',
    lede: 'The clause in the code, the drawing from 2019, the condition from the authority: Piloti finds them, with sources you check against the original. And then it keeps going, until the decision is on file.',
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
      title: 'What you can rely on',
      items: [
        'Every answer brings its sources, down to section, clause or page. You check against the original before anything goes into the submission; responsibility for the design stays where it belongs, with you.',
        'Your data stays yours: we do not train models on it, drawings and projects remain your office’s property, and no other office sees your archive.',
        'You build it with us: pilot offices get early access, a direct line to us founders and a say in what we build next.',
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
      body: 'Weighing several AI tools for your office? Piloti next to ChatGPT, Copilot, NotebookLM, Reiner AI and BaurechtGPT, compared, and why Piloti is the better choice for planning questions in Austria.',
      link: 'All comparisons',
    },
  },
  mailInbox: {
    heading: 'Project mail inbox: send files to a project by email',
    lede: 'Every project in Piloti has its own email address. Send drawings, permits or comments to it as attachments, and Piloti files them in the project as if you had uploaded them yourself. No more saving from Outlook and dragging the files back in.',
    address: {
      label: 'What a project address looks like',
      example: 'wohnbau-hietzing.k3m7q2xw4pab@…',
      note: 'The part before the dot is the project name, there for you to recognise the address. Only the twelve characters after it identify the project, so a renamed project keeps its address. The domain after the @ is a dedicated inbound domain set by your Piloti deployment.',
    },
    steps: {
      title: 'How it works',
      items: [
        {
          name: 'Copy the address',
          body: 'Open the project’s settings, section “Project email address”. The project address is there, with a button to copy it. Save it as a contact in your mail client.',
        },
        {
          name: 'Send the files',
          body: 'Send the files as attachments, from the address you sign in to Piloti with. Forward a mail from a consultant or the authority to the project address.',
        },
        {
          name: 'Carry on in the project',
          body: 'Each mail gets its own folder under `E-Mail-Eingang`, named after the date, the subject and the sender, for example `E-Mail-Eingang/2026-09-30 Einreichplan Rev C – Anna Berger`. When the files are filed, Piloti tells you in your inbox in the app.',
        },
      ],
      missing:
        'If you do not see the “Project email address” section, either you may not add documents to this project, or the inbox is not set up in your deployment. Your administrator can help.',
    },
    files: {
      title: 'What happens to the attachments',
      items: [
        'Every attachment becomes a document in the project, exactly like an upload: searchable, citable by Piloti in its answers, and versioned.',
        'The files count against your organization’s storage quota.',
        'The same file types and sizes apply as for uploads. A file that does not fit, or a full quota, skips that one file; the other attachments are still filed.',
        'Signature images (small inline images), empty attachments and `winmail.dat` from Outlook are skipped too. To get the content of a `winmail.dat`, set Outlook to HTML or plain text and send again.',
        'If a mail server delivers the same mail twice, Piloti files it once.',
      ],
    },
    senders: {
      title: 'Who can send',
      body: [
        'Only members of the organization who may add documents to that project. Piloti checks the sender address against the members of the organization the project belongs to, so send from the address you sign in with.',
        'Clients, consultants and authorities cannot send to the project address directly yet. Forward their mail yourself.',
      ],
    },
    verify: {
      title: 'The sender’s domain must be verifiable',
      body: [
        'Piloti accepts a mail only when it provably comes from your domain: it carries a valid DKIM signature from the domain in your sender address, or your domain publishes a DMARC policy of `quarantine` or `reject`. Otherwise anyone could put your address in the From line, and the mail is rejected.',
        'This hits Microsoft 365 most often. Unless your IT has set up DKIM for your own domain, Microsoft signs your mail as `yourcompany.onmicrosoft.com` instead of the domain in your sender address.',
      ],
      fixTitle: 'How your IT switches DKIM on',
      fixes: [
        {
          name: 'Microsoft 365',
          body: 'In the Microsoft Defender portal, under Email & collaboration → Policies & rules → Threat policies → Email authentication settings → DKIM, select your domain, publish the two CNAME records it shows in your DNS, then switch signing on.',
        },
        {
          name: 'Google Workspace',
          body: 'In the Admin console, under Apps → Google Workspace → Gmail → Authenticate email, generate the key, publish the TXT record in your DNS, then start authentication.',
        },
      ],
      fixNote: 'Until DKIM works, upload the files in the app.',
    },
    bounce: {
      title: 'Why a mail bounces',
      body: 'A rejected mail comes back with one general notice: the address is unknown, or the sender is not authorised or cannot be verified. The notice is the same for every reason, so that nobody can probe which addresses exist or who is a member. The reason is one of these:',
      reasons: [
        {
          name: 'The address is mistyped, or it was replaced by a new one.',
          body: 'Copy the current address from the project settings.',
        },
        {
          name: 'You are not a member of the project.',
          body: 'Ask whoever manages the project to add you.',
        },
        {
          name: 'You are a member but may not add documents.',
          body: 'Ask for a role that can edit documents.',
        },
        {
          name: 'You sent from a different address than your Piloti account.',
          body: 'Send from the address you sign in with.',
        },
        {
          name: 'Your domain cannot be verified.',
          body: 'Have DKIM switched on, as described above, or upload the files in the app.',
        },
      ],
    },
    limits: {
      title: 'Limits',
      items: [
        'At most 25 MB per mail, attachments included. Larger mails are rejected by the mail server before Piloti sees them.',
        'At most 60 mails per hour per project address. Mail above that is not lost: your mail server delivers it again later.',
      ],
    },
    privacy: {
      title: 'Privacy',
      items: [
        'The text of the mail is not stored, only the attachments. If the text matters, save it as a PDF and attach it.',
        'The subject appears in the folder name. If it names a person, it stays there until you rename or delete the folder.',
        'The mail is received through Cloudflare, Inc. (USA), which passes it on to Piloti. Cloudflare does not store the mail; it keeps only a delivery log with sender, recipient, subject and status. The mail is processed in the data centre nearest the sender, which can be outside the EU. Cloudflare is on the Piloti application’s list of sub-processors.',
        'Once the files are filed, the same applies to them as to any upload.',
      ],
    },
    rotate: {
      title: 'Getting a new address',
      body: [
        'If the address has reached someone who should not have it, whoever manages the project generates a new one in the project settings: “Project email address”, then “Generate new address”. The old address stops working at once, and mail to it bounces. Give the new address to everyone who sends files to the project.',
        'A leaked address on its own lets nobody file anything: the sender must still be a verified member with write access.',
      ],
    },
  },
}

export const pages: Record<Locale, typeof de> = { de, en }
