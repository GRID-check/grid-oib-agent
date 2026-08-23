---
name: brandschutz
description: >
  Brandabschnitt, Fluchtweg und Feuerwiderstand, sobald die GK steht.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: fire_compartment,egress_diagram,fire_access_plan,requirement_checklist,legal_basis
---

# Eine Brandschutzfrage beantworten

## Gebäudeklasse zuerst

Nahezu jede Anforderung in OIB Richtlinie 2 hängt an der Gebäudeklasse. Fehlt
sie und ändert sie die Antwort, `gebaeudeklasse` laden, bevor eine Zahl fällt.
Eine Feuerwiderstandsklasse ohne die Klasse, aus der sie folgt, ist eine Zahl
ohne Anspruch.

Die Edition bindet mit. Hol sie, nenn sie, sobald sie den Wert verschiebt.

## Anforderung und Nachweis auseinanderhalten

Die Richtlinie sagt, was erfüllt sein muss. Ob es in diesem Gebäude erfüllt
*ist*, ist ein Befund an diesem Vorhaben. Sag, welches von beiden du
geliefert hast. Eine grobe Prüfung am Plan ist kein Brandschutzkonzept. Der
Unterschied verschwindet, sobald die Karte ohne den Satz weitergeht. Also in
den Satz.

## Der zweite Fluchtweg ist zwei Fragen

Ob einer verlangt ist, folgt aus Klasse und Nutzung. Ob er zählt, folgt daraus,
wohin er führt. Beides beantworten, oder sagen, welches offen ist.

## Welches Bild

Ein Geschoß in Brandabschnitte geteilt, Flächen gegen die Grenze →
`fire_compartment`.
Ein Fluchtweg aus Segmenten, deren Summe geprüft wird → `egress_diagram`. Die
Segmente einzeln, nie nur die Summe: die Frage ist fast immer, *welches*
Segment zu lang ist.
Zufahrt, Durchfahrt, Aufstellfläche → `fire_access_plan`.
Mehrere Anforderungen, jede mit eigenem Urteil → `requirement_checklist`.
Die Bestimmung selbst → `legal_basis`.

## Done

Jedes Urteil hat eine Fundstelle und sagt, ob es die Anforderung oder den
Nachweis ist. Fehlt die Klasse, ist das die offene Tatsache, nicht eine
geschätzte Widerstandsklasse.
