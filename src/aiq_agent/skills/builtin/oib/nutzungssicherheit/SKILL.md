---
name: nutzungssicherheit
description: >
  Treppe, Geländer, Türbreite. Die Zahl gehört gezeichnet.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: stair_diagram,guardrail_check,dimension_diagram,elevator_requirement,legal_basis
---

# Eine Frage zu Nutzungssicherheit oder Barrierefreiheit beantworten

## Ein Maß wird gezeichnet, nicht beschrieben

Ein Auftritt gegen ein Minimum ist als Satz eine Zahl, die die Leserin im Kopf
neu zeichnen muss, und als Zeichnung sofort lesbar. Den Satz trotzdem
schreiben. Die Karte ist zusätzlich, nie stattdessen.

Steigung, Auftritt, Laufbreite, Schrittmaß → `stair_diagram`.
Absturzhöhe, Geländerhöhe, Öffnungsweite, der Spalt darunter →
`guardrail_check`. Die Absturzhöhe entscheidet die Grenze, also gehört sie
in die Karte.
Lichte Breite, Rampe, Wendekreis, Bewegungsfläche, Stellplatz →
`dimension_diagram`, `shape` passend zum Gegenstand.
Aufzugspflicht und Kabinenmaße → `elevator_requirement`.

## Herkunft der Zahl

Eine Zahl aus der Frage ist behauptet. Eine Zahl, die du aus angegebenen
Werten rechnest, sagt das. Fehlt sie, den Check auf `needs_input` setzen und
hineinschreiben, was dem Plan fehlt. Nie schätzen. Eine geschätzte Zahl in
einer Karte ist die schlechteste Ausgabe dieses Produkts, weil die Karte genau
die Darstellung ist, die ohne den umgebenden Text weitergeht.

Welches Maß die Bestimmung verlangt, steht in der Klausel. Rohbaulichte und
fertige Durchgangsbreite sind verschiedene Zahlen. Nicht die eine unter dem
Namen der anderen abliefern.

## Barrierefreiheit ist nicht nur ein Maß

Die Maße sind das Prüfbare. Die Anforderung ist meist, dass etwas erreichbar
und benutzbar ist. Wo die Richtlinie ein Ziel nennt und kein Maß, das sagen,
statt ein Maß zu zitieren, das nur ein üblicher Weg zum Ziel ist.

## Done

Jedes Maß hat eine Herkunft oder steht als fehlend. Kein geschätztes Maß in
einer Karte. Die Bestimmung ist zitiert, nicht nur die Zahl.
