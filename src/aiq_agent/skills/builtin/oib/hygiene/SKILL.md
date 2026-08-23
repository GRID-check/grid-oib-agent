---
name: hygiene
description: >
  Ob dieser Raum ein Aufenthaltsraum ist, und was OIB 3 dann verlangt.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: daylight_incidence,requirement_checklist,legal_basis
---

# Zuerst den Raum einordnen, dann die Anforderung holen

OIB 3 hängt daran, ob etwas ein Aufenthaltsraum ist. Das ist eine rechtliche
Einordnung, kein Raumstempel und kein Name auf dem Plan. Die Maße kommen danach.

## 1. Was ist dieser Raum?

Hol die Bestimmung, die Aufenthaltsraum definiert. Wende sie auf die Nutzung
und die Angaben in der Frage oder in den Projektunterlagen an. Unklar → eine
Frage, kein stilles Ja.

**Fertig**, sobald die Einordnung eine Fundstelle hat oder als offen steht.

## 2. Dann die Anforderung, dann das Maß

Raumhöhe, Belichtung, Lüftung, Fensterfläche: die Grenze steht in der Klausel.
Das Maß kommt aus der Frage, dem Plan oder den Unterlagen. Nie umgekehrt, sonst
prüfst du das Falsche sauber.

Die Bestimmung liefert den Grenzwert. Eine Zahl ohne Herkunft ist behauptet.

## 3. Zeigen

Belichtung mit Prisma und Glasanteil → `daylight_incidence`.
Mehrere Anforderungen nebeneinander → `requirement_checklist`.
Die Klausel → `legal_basis`.

## Was schiefläuft

Ein geschnittenes Lichtprisma ist kein Verbot des Fensters. Es ändert die
erforderliche Fläche. Wer aus „geschnitten“ ein „nicht erfüllt“ macht, hat die
Bestimmung übersprungen.

Die Geschoßhöhe ist nicht die lichte Raumhöhe. Die Herkunft der Zahl gehört
in den Satz.

Bestand, Zubau und größere Renovierung holen oft andere Anforderungen als
Neubau. `bestand_neubau` im Projektkontext lesen, bevor eine Neubau-Klausel
zitiert wird.

## Done

Die Einordnung steht, die Klausel ist zitiert, das Maß hat eine Herkunft. Oder
es fehlt genau die Tatsache, die die Einordnung trägt.
