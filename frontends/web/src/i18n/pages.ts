/**
 * The copy of /warum-piloti/, the argument page. Kept out of ui.ts because it
 * is a page of prose, not interface strings; its title and description stay
 * in ui.ts `seo.pages` with every other page's. The comparisons are search
 * pages now (src/data/landing/vergleich.ts).
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
      body: 'Sie prüfen gerade mehrere KI-Werkzeuge für Ihr Büro? Piloti neben ChatGPT, Copilot, NotebookLM, Reiner AI und BaurechtGPT, ehrlich verglichen, auch dort, wo die anderen vorn liegen.',
      link: 'Alle Vergleiche',
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
      body: 'Weighing several AI tools for your office? Piloti next to ChatGPT, Copilot, NotebookLM, Reiner AI and BaurechtGPT, compared honestly, including where the others are ahead.',
      link: 'All comparisons',
    },
  },
}

export const pages: Record<Locale, typeof de> = { de, en }
