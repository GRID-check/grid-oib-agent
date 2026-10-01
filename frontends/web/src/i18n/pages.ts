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
      example: 'wohnbau-hietzing.k3m7q2xw4pab@piloti.at',
      note: 'Vor dem Punkt steht der Projektname, damit Sie die Adresse wiedererkennen. Nur die zwölf Zeichen danach bestimmen das Projekt, darum behält ein umbenanntes Projekt seine Adresse. Nach dem @ steht piloti.at, die Domain von Piloti selbst.',
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
          body: 'Senden Sie die Dateien als Anhang, von der Adresse, mit der Sie sich bei Piloti anmelden, und setzen Sie die Projektadresse in „An“ oder „Cc“. Eine E-Mail vom Fachplaner oder von der Behörde leiten Sie aus Ihrem E-Mail-Programm an die Projektadresse weiter.',
        },
        {
          name: 'Im Projekt weiterarbeiten',
          body: 'Piloti nimmt die E-Mail sofort an und legt die Dateien kurz danach ab, meist innerhalb einer Minute. Jede E-Mail bekommt einen eigenen Ordner unter `E-Mail-Eingang`, benannt nach Uhrzeit und Absender, etwa `E-Mail-Eingang/2026-09-30 10.15 – Anna Berger`. Ihr Postfach in der App meldet, was abgelegt wurde und was nicht.',
        },
      ],
      missing:
        'Sehen Sie den Abschnitt „E-Mail-Eingang“ nicht, dürfen Sie in diesem Projekt keine Dokumente hinzufügen, oder der E-Mail-Eingang ist für Ihre Organisation nicht eingeschaltet. Er wird je Organisation eingeschaltet, nachdem sie informiert wurde, dass E-Mails über Cloudflare eingehen. Dann hilft Ihre Administration weiter.',
    },
    files: {
      title: 'Was mit den Anhängen passiert',
      items: [
        'Jeder Anhang wird ein Dokument im Projekt, genau wie ein Upload: durchsuchbar, von Piloti in Antworten zitierbar und mit Fassungen. Die Dateien zählen zum Speicherkontingent Ihrer Organisation.',
        'Es gelten dieselben Dateitypen und Größen wie beim Hochladen. Passt eine Datei nicht oder ist das Kontingent voll, wird nur diese Datei übersprungen; die übrigen Anhänge werden trotzdem abgelegt.',
        'Eine als Anhang weitergeleitete E-Mail (`.eml`) öffnet Piloti und legt die Dateien darin ab, nicht die E-Mail selbst.',
        'Nicht abgelegt werden Bilder, die in den Text der E-Mail eingefügt sind, und Signaturlogos, etwa `image001.png` oder Bilder unter 2 KB. Brauchen Sie ein Bild im Projekt, hängen Sie es als Datei an.',
        'Ebenfalls nicht abgelegt: die Signatur einer signierten E-Mail (`smime.p7s`), verschlüsselte Teile (`smime.p7m`, PGP), Kalendereinladungen, leere Anhänge und `winmail.dat` aus Outlook. Für den Inhalt einer `winmail.dat` stellen Sie Outlook auf HTML oder Nur-Text und senden erneut.',
        'Links auf Cloud-Dateien (OneDrive, Google Drive, WeTransfer) ruft Piloti nicht ab. Hängen Sie die Dateien an oder laden Sie sie in der App hoch.',
        'Die Meldung in Ihrem Postfach nennt jede nicht abgelegte Datei mit dem Grund. Gelingt die Ablage auch nach etwa einem Tag voller Wiederholungen nicht, meldet Piloti auch das; laden Sie die Dateien dann in der App hoch.',
        'Stellt ein Mailserver dieselbe E-Mail zweimal zu, legt Piloti sie einmal ab.',
      ],
    },
    senders: {
      title: 'Wer senden kann',
      body: [
        'Nur Mitglieder der Organisation, die im jeweiligen Projekt Dokumente hinzufügen dürfen. Piloti vergleicht die Absenderadresse mit den Mitgliedern der Organisation, der das Projekt gehört. Senden Sie deshalb von der Adresse, mit der Sie sich anmelden.',
        'Die Projektadresse gehört in „An“ oder „Cc“. Steht sie nur in „Bcc“, wird die E-Mail abgelehnt: Piloti nimmt eine E-Mail nur an, wenn die Signatur Ihres Mailservers eine Empfängerzeile mit der Projektadresse abdeckt. So lässt sich eine E-Mail, die Sie an jemand anderen geschickt haben, nicht in ein Projekt umleiten.',
        'Bauherrschaft, Fachplaner und Behörden können noch nicht direkt an die Projektadresse senden. Leiten Sie deren E-Mails selbst weiter. Setzen Sie die Projektadresse nicht in E-Mails an Personen außerhalb Ihres Büros: Sie landet sonst in deren Adressbüchern und in jedem „Allen antworten“, und jede Antwort von dort kommt zurück.',
      ],
    },
    verify: {
      title: 'Die Domain des Absenders muss prüfbar sein',
      body: [
        'Piloti nimmt eine E-Mail nur an, wenn sie nachweislich von Ihrer Domain kommt: Sie trägt eine gültige DKIM-Signatur der Domain in Ihrer Absenderadresse. Eine DMARC-Richtlinie allein genügt nicht. Ohne diese Signatur könnte jeder Ihre Adresse in die Absenderzeile schreiben, und die E-Mail wird abgelehnt.',
        'Am häufigsten betrifft das Microsoft 365 und Google Workspace: Solange Ihre IT DKIM nicht für die eigene Domain eingerichtet hat, signiert Microsoft Ihre E-Mails mit `ihrbuero.onmicrosoft.com` und Google mit einer Domain unter `gappssmtp.com`, nicht mit der Domain Ihrer Absenderadresse.',
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
          body: 'Kopieren Sie die aktuelle Adresse aus den Projekteinstellungen. Lautet der Hinweis nur „Unbekannte Adresse“, hat die Adresse nicht einmal die Form einer Projektadresse, meist weil beim Abtippen ein Zeichen verloren ging oder dazukam.',
        },
        {
          name: 'Der E-Mail-Eingang ist für Ihre Organisation nicht eingeschaltet.',
          body: 'Wenden Sie sich an Ihre Administration.',
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
          name: 'Die Projektadresse stand nur in „Bcc“.',
          body: 'Setzen Sie sie in „An“ oder „Cc“.',
        },
        {
          name: 'Die E-Mail kam von einem Scanner, einem Multifunktionsgerät oder einer Weiterleitungsregel auf dem Mailserver.',
          body: 'Solche E-Mails tragen eine fremde Absenderadresse, keine passende Signatur oder Empfängerzeilen ohne die Projektadresse. Leiten Sie aus Ihrem E-Mail-Programm weiter, oder laden Sie den Scan in der App hoch.',
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
        'Anhänge zusammen höchstens etwa 18 MB pro E-Mail. Die E-Mail selbst darf 25 MB groß sein, doch als Anhang kodiert wird eine Datei rund ein Drittel größer. Größere E-Mails lehnt der Mailserver ab, bevor Piloti sie sieht.',
        'Höchstens 100 Dateien pro E-Mail. Weitere werden übersprungen und in der Meldung genannt.',
        'Höchstens 60 E-Mails pro Stunde je Projektadresse. Was darüber hinausgeht, geht nicht verloren: Ihr Mailserver stellt es später erneut zu.',
      ],
    },
    privacy: {
      title: 'Datenschutz',
      items: [
        'Der Text der E-Mail wird nicht gespeichert, nur die Anhänge. Kommt es auf den Text an, speichern Sie ihn als PDF und hängen Sie ihn an.',
        'Der Betreff steht in keinem Ordner- oder Dateinamen. Er erscheint nur in Ihrer eigenen Meldung im Postfach der App, die nach 30 Tagen gelöscht wird.',
        'Bis zur Ablage liegen die ausgewählten Anhänge im Speicher Ihrer Organisation, höchstens sieben Tage. Den Eingangsdatensatz jeder E-Mail löscht Piloti nach 30 Tagen.',
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
      example: 'wohnbau-hietzing.k3m7q2xw4pab@piloti.at',
      note: 'The part before the dot is the project name, there for you to recognise the address. Only the twelve characters after it identify the project, so a renamed project keeps its address. After the @ comes piloti.at, Piloti’s own domain.',
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
          body: 'Send the files as attachments, from the address you sign in to Piloti with, and put the project address in To or Cc. Forward a mail from a consultant or the authority to the project address from your mail client.',
        },
        {
          name: 'Carry on in the project',
          body: 'Piloti accepts the mail at once and files the attachments shortly afterwards, usually within a minute. Each mail gets its own folder under `E-Mail-Eingang`, named after the time and the sender, for example `E-Mail-Eingang/2026-09-30 10.15 – Anna Berger`. Your inbox in the app tells you what was filed and what was not.',
        },
      ],
      missing:
        'If you do not see the “Project email address” section, either you may not add documents to this project, or the mail inbox is not switched on for your organization. It is switched on per organization, after the organization has been told that mail is received through Cloudflare. Your administrator can help.',
    },
    files: {
      title: 'What happens to the attachments',
      items: [
        'Every attachment becomes a document in the project, exactly like an upload: searchable, citable by Piloti in its answers, and versioned. The files count against your organization’s storage quota.',
        'The same file types and sizes apply as for uploads. A file that does not fit, or a full quota, skips that one file; the other attachments are still filed.',
        'A mail forwarded as an attachment (`.eml`) is opened, and the files inside it are filed, not the mail itself.',
        'Images pasted into the text of the mail and signature logos, such as `image001.png` or images under 2 KB, are not filed. If you need an image in the project, attach it as a file.',
        'Also not filed: the signature of a signed mail (`smime.p7s`), encrypted parts (`smime.p7m`, PGP), calendar invites, empty attachments and `winmail.dat` from Outlook. To get the content of a `winmail.dat`, set Outlook to HTML or plain text and send again.',
        'Links to cloud files (OneDrive, Google Drive, WeTransfer) are not fetched. Attach the files, or upload them in the app.',
        'The notification in your inbox lists every file that was not filed, with the reason. If the files still cannot be filed after about a day of retries, Piloti tells you that too; upload them in the app then.',
        'If a mail server delivers the same mail twice, Piloti files it once.',
      ],
    },
    senders: {
      title: 'Who can send',
      body: [
        'Only members of the organization who may add documents to that project. Piloti checks the sender address against the members of the organization the project belongs to, so send from the address you sign in with.',
        'Put the project address in To or Cc. A mail that has it only in Bcc is refused: Piloti accepts a mail only when your mail server’s signature covers a recipient line that names the project address. That way a mail you sent to someone else cannot be redirected into a project.',
        'Clients, consultants and authorities cannot send to the project address directly yet. Forward their mail yourself. Do not put the project address in mail to people outside your office: it would end up in their address books and in every reply-all, and each of their replies would bounce.',
      ],
    },
    verify: {
      title: 'The sender’s domain must be verifiable',
      body: [
        'Piloti accepts a mail only when it provably comes from your domain: it carries a valid DKIM signature from the domain in your sender address. A DMARC policy alone is not enough. Without that signature anyone could put your address in the From line, and the mail is refused.',
        'This hits Microsoft 365 and Google Workspace most often. Unless your IT has set up DKIM for your own domain, Microsoft signs your mail as `yourcompany.onmicrosoft.com` and Google with a domain under `gappssmtp.com`, not with the domain in your sender address.',
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
      body: 'A refused mail comes back with one general notice: the address is unknown, or the sender is not authorised or cannot be verified. The notice is the same for every reason, so that nobody can probe which addresses exist or who is a member. The reason is one of these:',
      reasons: [
        {
          name: 'The address is mistyped, or it was replaced by a new one.',
          body: 'Copy the current address from the project settings. If the notice says only “Unknown address”, the address does not even have the form of a project address, usually because a character was lost or added while typing it.',
        },
        {
          name: 'The mail inbox is not switched on for your organization.',
          body: 'Ask your administrator.',
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
          name: 'The project address was only in Bcc.',
          body: 'Put it in To or Cc.',
        },
        {
          name: 'The mail came from a scanner, a multifunction device or a forwarding rule on the mail server.',
          body: 'Such mail carries another sender address, no matching signature, or recipient lines without the project address. Forward it from your mail client, or upload the scan in the app.',
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
        'Attachments of about 18 MB in total per mail. The mail itself may be 25 MB, but encoding a file as an attachment makes it about a third larger. Larger mails are refused by the mail server before Piloti sees them.',
        'At most 100 files per mail. Any more are skipped and listed in the notification.',
        'At most 60 mails per hour per project address. Mail above that is not lost: your mail server delivers it again later.',
      ],
    },
    privacy: {
      title: 'Privacy',
      items: [
        'The text of the mail is not stored, only the attachments. If the text matters, save it as a PDF and attach it.',
        'The subject is in no folder or file name. It appears only in your own notification in the app’s inbox, which is deleted after 30 days.',
        'Until they are filed, the selected attachments wait in your organization’s storage, for seven days at most. Piloti deletes its record of each received mail after 30 days.',
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
