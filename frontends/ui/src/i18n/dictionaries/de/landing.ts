import type { en } from '../en'

/** landing namespace — marketing/landing surface copy. */
export const landing: typeof en.landing = {
  loading: {
    workspace: 'Ihr Arbeitsbereich wird geladen…',
  },
  topBar: {
    signIn: 'Anmelden',
  },
  hero: {
    eyebrow: 'OIB- & RIS-Compliance-Copilot für österreichische Architektinnen und Architekten',
    title: 'Jede Antwort, verankert in der Bauordnung.',
    subtitle:
      'Grid beantwortet baurechtliche Compliance-Fragen für jedes Ihrer Projekte — verankert in den OIB-Richtlinien und österreichischen Rechtsquellen aus dem RIS. Jede Antwort ist auf das jeweilige Projekt bezogen und auf die genaue Richtlinie und den genauen Paragraphen zitiert, sodass Sie sie anhand der Vorschrift selbst überprüfen können.',
    signIn: 'Anmelden',
    sso: 'Single Sign-on für Ihr Büro',
  },
  howItWorks: {
    eyebrow: 'So funktioniert es',
    title: 'Von den Plänen zur zitierten Antwort, ohne die Vorschrift zu verlassen.',
    steps: {
      create: {
        title: 'Projekt anlegen',
        body: 'Richten Sie für jedes Bauwerk einen Arbeitsbereich ein. Grid hält jede Frage, jede Quelle und jede Antwort auf dieses Projekt bezogen.',
      },
      documents: {
        title: 'Pläne & Dokumente hinzufügen',
        body: 'Laden Sie Ihre Pläne, Bescheide und Spezifikationen hoch. Grid liest sie zusammen mit den OIB-Richtlinien und den RIS-Rechtsquellen.',
      },
      answers: {
        title: 'Grid fragen, zitierte Antworten erhalten',
        body: 'Stellen Sie jede baurechtliche Frage in natürlicher Sprache. Jede Antwort wird auf die genaue Richtlinie und den genauen Paragraphen zitiert, die Sie überprüfen können.',
      },
      research: {
        title: 'Tiefenrecherche durchführen',
        body: 'Lassen Sie Grid bei komplexen Fragen die Quellen Schritt für Schritt durcharbeiten und einen strukturierten, vollständig belegten Bericht liefern.',
      },
    },
  },
  trust: {
    eyebrow: 'Präzision, die Sie überprüfen können',
    title: 'Gemacht für Arbeit, bei der das Zitat die Antwort ist.',
    intro:
      'Baurechtliche Compliance lässt keinen Raum für eine selbstbewusste Vermutung. Grid ist so konzipiert, dass jede Aussage anhand ihrer Quelle überprüft werden kann — so wie eine Architektin oder ein Architekt einen Entwurf freigibt.',
    points: {
      grounded: {
        title: 'Verankert in den OIB-Richtlinien',
        body: 'Antworten stammen aus den österreichischen Baurichtlinien — denselben Vorschriften, an die Sie gebunden sind — und niemals aus unbelegten Allgemeinplätzen.',
      },
      traceable: {
        title: 'Nachvollziehbar bis zum RIS',
        body: 'Gesetze und Verordnungen werden mit dem Rechtsinformationssystem des Bundes verknüpft, sodass jede Rechtsgrundlage zu ihrer Primärquelle führt.',
      },
      cited: {
        title: 'Zitiert bis zum genauen Paragraphen',
        body: 'Jede Antwort nennt die Richtlinie und den §, auf die sie sich stützt, samt dem zitierten Auszug, sodass Sie die Vorschrift prüfen — nicht das Modell.',
      },
    },
  },
  closing: {
    title: 'Beantworten Sie Ihre nächste baurechtliche Frage mit Zuversicht.',
    subtitle:
      'Melden Sie sich an, um ein Projekt anzulegen, Ihre Dokumente hinzuzufügen und Antworten zu erhalten, die auf die genaue OIB-Richtlinie zitiert sind.',
    signIn: 'Anmelden',
  },
  footer: {
    description: 'Baurechtliche Antworten für österreichische Architektinnen und Architekten, verankert in der Vorschrift.',
    sources: 'Quellen: OIB-Richtlinien · RIS · Ihre Projektdokumente',
    legalNav: 'Rechtliches',
  },
  card: {
    legalBasis: 'Rechtsgrundlage',
    summary:
      'Für die Gebäudeklasse dieses Projekts müssen tragende Bauteile ihre Feuerwiderstandsdauer für den erforderlichen Zeitraum aufrechterhalten, und die Anordnung muss die Ausbreitung von Feuer und Rauch zwischen den Brandabschnitten begrenzen.',
    viewSource: 'OIB-Richtlinie 2 ansehen',
    verifiedSource: 'Geprüfte Quelle',
  },
}
