---
name: brandschutz
description: >
  Bei Fragen zu Brandschutz laden: Brandabschnitt, Feuerwiderstand (REI/EI),
  Fluchtweg und Fluchtweglänge, zweiter Fluchtweg, Rettungsweg, Stiegenhaus,
  Brandwand, Brandschutzklappe, Rauchabschnitt, Feuerwehrzufahrt und
  Aufstellfläche, Löschwasser, GK-abhängige Anforderungen der OIB-Richtlinie 2.
  Auch wenn die Frage aus einem Modell oder einem Einreichplan kommt.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: fire_compartment,egress_diagram,fire_access_plan,requirement_checklist,legal_basis
---

# Brandschutz beantworten

## Zuerst die Gebäudeklasse, sonst nichts

Fast jede Anforderung der OIB-Richtlinie 2 hängt an der Gebäudeklasse, und die
Gebäudeklasse hängt an Fluchtniveau, Geschoßanzahl, Grundfläche und Nutzung.
Ist die GK im Projektkontext bestätigt, rechnen Sie nicht nach — nehmen Sie
sie. Ist sie unbekannt und ändert sie die Antwort, fragen Sie **eine** Frage
danach, bevor Sie antworten. Eine Feuerwiderstandsklasse ohne die GK, aus der
sie folgt, ist eine Zahl ohne Aussage.

Ebenso bindend: die Ausgabe. Die Bundesländer erklären unterschiedliche
Ausgabestände der Richtlinie für verbindlich. Nennen Sie die Ausgabe, auf die
Sie sich stützen, sobald sie den Wert beeinflusst.

## Welche Card wozu

- Ein Geschoß in Brandabschnitte geteilt, mit Flächen gegen den Grenzwert →
  `fire_compartment`.
- Ein Fluchtweg aus Teilstrecken, deren Summe geprüft wird → `egress_diagram`.
  Die Teilstrecken einzeln eintragen, nicht die Summe: die Frage ist fast immer,
  welche Teilstrecke zu lang ist.
- Zufahrt, Durchfahrt, Aufstellfläche → `fire_access_plan`.
- Mehrere Anforderungen mit je eigenem Urteil (typisch „was gilt für GK 4") →
  `requirement_checklist`, eine Zeile je Anforderung mit eigener Fundstelle.
- Die Bestimmung, auf der die Antwort ruht → `legal_basis`.

## Was hier regelmäßig schiefgeht

**Der zweite Fluchtweg wird als Zahl behandelt.** Ob ein zweiter Fluchtweg
verlangt ist, folgt aus GK und Nutzung; ob er anrechenbar ist, folgt daraus,
wohin er führt. Beantworten Sie beides oder sagen Sie, welches offen ist.

**Der Nachweis wird mit der Anforderung verwechselt.** Die Richtlinie sagt, was
erfüllt sein muss. Ob es im konkreten Bau erfüllt IST, ist eine Feststellung am
Objekt oder am Modell. Sagen Sie, welches von beidem Sie geliefert haben.

**Eine orientierende Prüfung wird als Nachweis gelesen.** Wenn die Antwort aus
einer Regelprüfung am Modell stammt, muss sie das mitsagen — ein Prüfbuch ist
kein Brandschutzkonzept, und der Unterschied verschwindet, sobald die Card ohne
den Satz weitergereicht wird.
