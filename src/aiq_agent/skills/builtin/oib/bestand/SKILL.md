---
name: bestand
description: >
  Was nach Umbau, Nutzungsänderung oder größerer Renovierung noch bindet.
metadata:
  grid-catalog: curated
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: requirement_checklist,condition_tree,legal_basis
---

# Zuerst das Regime, dann die Anforderung

Die Mehrheit der Arbeit ist Bestand. Eine Neubau-Klausel auf einen Dachausbau
gelegt ist die häufigste falsche Zahl, die dieser Agent liefern kann, und sie
liest sich korrekt.

## 1. Welches Vorhaben ist das

Umbau, Zubau, Nutzungsänderung, größere Renovierung, Instandsetzung. Die Worte
sind nicht synonym. Hol die Bestimmung, die sie für dieses Land unterscheidet,
und ordne das Vorhaben dort ein. `vorhabensart` und `bestand_neubau` im
Projektkontext lesen, nicht überschreiben.

Unklar → eine Frage. Nicht unter Neubau weiterarbeiten und es am Ende erwähnen.

**Fertig**, sobald das Regime einen Namen und eine Fundstelle hat.

## 2. Was noch bindet

Bestandsschutz, die verbindliche OIB-Ausgabe, ob die Änderung die Klasse
verschiebt, ob eine größere Renovierung die Hülle neu aufrollt. Jedes davon
ist eine holbare Klausel, kein Gefühl.

Die Gebäudeklasse kann sich durch den Umbau ändern. Wenn sie sich ändert,
ändert sich fast jede spätere Zahl. Dann `gebaeudeklasse` laden, bevor eine
Anforderung zitiert wird.

## 3. Abweichung, wenn die Anforderung nicht haltbar ist

Gleiches Schutzniveau ist ein Fall, kein Hoffnungssatz. Der Fall zitiert:

- welche Anforderung nicht erfüllt wird, mit Fundstelle
- welches Schutzziel sie trägt
- womit dasselbe Ziel hier erreicht wird, an diesem Objekt
- was dafür nachgewiesen werden muss

Eine Erinnerung an „macht die Behörde oft mit“ ist kein Fall.

## 4. Zeigen

Mehrere Anforderungen, jede mit eigenem Urteil → `requirement_checklist`.
Das Regime gabelt die Antwort → `condition_tree`.
Die bindende Klausel → `legal_basis`.
Eine Frist oder ein Vorbehalt, der das nächste Tun ändert → das `callout`-Feld
der Antwort (`answer_json`-Envelope), höchstens eines.

## Done

Das Regime ist genannt. Jede zitierte Anforderung gehört zu diesem Regime, nicht
zum Neubau daneben. Offene Punkte sind Fragen oder ein Abweichungsfall, kein
geschätzter Grenzwert.
