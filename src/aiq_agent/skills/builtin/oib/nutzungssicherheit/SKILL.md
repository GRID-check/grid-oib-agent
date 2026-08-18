---
name: nutzungssicherheit
description: >
  Bei Fragen zu Nutzungssicherheit und Barrierefreiheit laden: Treppe, Stiege,
  Steigung und Auftritt, Schrittmaßregel, Laufbreite, Podest, Geländer,
  Brüstung, Absturzsicherung, Öffnungsweite, Rampe, Neigung, Bewegungsfläche,
  Wendekreis, lichte Durchgangsbreite, Türbreite, barrierefreier Aufzug,
  Kabinenmaße, Anforderungen der OIB-Richtlinie 4.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: stair_diagram,guardrail_check,dimension_diagram,elevator_requirement,legal_basis
---

# Nutzungssicherheit und Barrierefreiheit beantworten

## Maße gehören gezeichnet, nicht beschrieben

Das ist die eine Genre-Regel, die alles andere trägt: Eine Antwort, die auf
einem Maß beruht, bekommt die Card zu diesem Maß. Ein Auftritt von 27 cm gegen
eine Mindestanforderung ist als Satz eine Zahl, die der Leser im Kopf
nachzeichnen muss, und als Zeichnung sofort lesbar. Schreiben Sie den Satz
trotzdem — die Card ergänzt die Antwort, sie ersetzt sie nicht.

- Steigung, Auftritt, Laufbreite, Schrittmaß → `stair_diagram`.
- Absturzhöhe, Geländerhöhe, Öffnungsweite, unterer Spalt → `guardrail_check`.
  Die Absturzhöhe entscheidet den Grenzwert, also muss sie in der Card stehen.
- Lichte Breite, Rampe, Wendekreis, Bewegungsfläche, Stellplatz →
  `dimension_diagram`, `shape` passend zum Gegenstand.
- Aufzugspflicht und Kabinenmaße → `elevator_requirement`.

## Gemessen, gerechnet oder behauptet

Wenn eine Zahl aus `ifc_measure` kommt, tragen Sie ihre Provenienz und ihre
Toleranz mit in die Card. Ein berechnetes Maß ohne sein ± Band liest sich wie
ein exaktes, und genau daran entscheidet sich, ob 2,47 m eine 2,50-m-Grenze
hält. Eine Zahl aus der Frage des Nutzers ist weder gemessen noch berechnet —
dort bleiben beide Felder leer.

Fehlt ein Maß, setzen Sie den Prüfpunkt auf `needs_input` und schreiben hinein,
was im Plan fehlt. Schätzen Sie nie. Ein geschätztes Maß in einer Card ist die
schlechteste Ausgabe, die dieses Produkt erzeugen kann, weil es genau die
Darstellung ist, die ohne den umgebenden Text weitergereicht wird.

## Barrierefreiheit ist nicht nur ein Maß

Die Maße sind das Prüfbare; die Anforderung ist meist, dass etwas erreichbar
und benutzbar ist. Wo die Richtlinie ein Ziel formuliert und nicht ein Maß,
sagen Sie das, statt ein Maß zu nennen, das nur ein üblicher Weg zum Ziel ist.
