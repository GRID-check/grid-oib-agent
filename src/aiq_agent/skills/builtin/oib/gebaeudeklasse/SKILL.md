---
name: gebaeudeklasse
description: >
  Die Gebäudeklasse, an der jede spätere OIB-Zahl hängt.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: condition_tree,building_section,legal_basis
---

# Gebäudeklasse feststellen, bevor eine Zahl fällt

Die Klasse ist keine Meinung. Sie folgt aus Fluchtniveau, Geschoßzahl, Fläche
und Nutzung. Die Tabelle selbst steht in der Richtlinie. Hier steht nur, wann
du sie holst und wann du ohne sie nicht weiterarbeitest.

## 1. Nimm die bestätigte Klasse

Steht im Projektkontext eine Gebäudeklasse als bestätigt, nimm sie. Nicht neu
ableiten. Widerspricht die Frage der bestätigten Klasse, sag den Widerspruch
und arbeit unter der bestätigten weiter, bis jemand sie ändert.

**Fertig**, sobald die Klasse einen Fundstellenanker hat oder ausdrücklich als
unbestätigt geführt wird.

## 2. Fehlt sie, und ändert sie die Antwort: eine Frage

Ohne Klasse eine Feuerwiderstandsklasse zu nennen ist eine Zahl ohne Anspruch.
Frag genau das, was die Klasse entscheidet: Fluchtniveau, oberirdische
Geschoße, Nutzung. Eine Frage, nicht vier.

Kannst du unter einer klar benannten Annahme sinnvoll antworten, tu das und
markier die Annahme. Nicht raten und die Klasse verschweigen.

## 3. Die Edition bindet mit

Jedes Land erklärt eine andere Ausgabe verbindlich. Nenn die Ausgabe, sobald
sie den Wert verschiebt. Hol sie aus der Wissensbasis oder aus RIS, nicht aus
dem Gedächtnis.

## 4. Zeigen

Die Antwort gabelt sich an der Klasse → `condition_tree`, der aktive Ast ist
dieser Fall.
Höhe und Fluchtniveau sind der Gegenstand → `building_section`.
Die Bestimmung selbst → `legal_basis`.

## Done

Eine Klasse mit Fundstelle, oder die eine fehlende Tatsache, ohne die keine
Klasse existiert. Keine Tabelle aus dem Gedächtnis.
