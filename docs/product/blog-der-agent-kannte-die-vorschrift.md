# Der Agent kannte die Vorschrift. Er kannte nur das Gebäude nicht.

*Entwurf für einen Blogartikel. Deutsch, weil die Leserinnen Architektinnen in
Österreich sind. Der Ton ist Problem und Haltung, nicht Feature-Ankündigung —
wer die Geschichte des Fehlers nicht erzählt, kann die Lösung nicht begründen.*

---

Eine Architektin lädt ihr IFC-Modell hoch und fragt unseren Agenten, ob ein
Fenster mit dem Dach darüber für den Lichteinfall funktioniert. Was sie
zurückbekommt, ist auf den ersten Blick beeindruckend. Der Agent findet OIB
Richtlinie 3, Punkt 9. Er erklärt das 45°-Prisma über der Unterkante der
Lichteintrittsfläche. Er erwähnt die seitliche Schwenkung um 30°. Alles richtig,
alles belegt.

Und dann, in der Vertrauensnotiz am Ende, fünf Wörter:

> **Überstand/Raum-% im IFC nicht messbar.**

Jede einzelne dieser Zahlen stand in der Datei.

Der Dachüberstand: 0,647 m, aus den Dreiecken des Dachkörpers, normal auf die
Außenebene der Wand. Die Bodenfläche des Raums: 15,42 m². Die Brüstungshöhe:
0,900 m. Der Sturz: 2,110 m. Die Fassade zeigt nach Norden — die Datei
deklariert eine Nordrichtung, man muss sie nur lesen. Der Agent hat nichts davon
gesehen, und er hat auch nicht behauptet, es gesehen zu haben. Er hat gesagt:
das geht nicht.

Das ist der Fehler, um den es hier geht. Nicht eine falsche Antwort. Eine
korrekte Aussage über die eigene Blindheit — die schlicht nicht gestimmt hat.

## Warum ein Agent ein Gebäude nicht sieht

Fast jede Pipeline, die IFC verarbeitbar macht, macht dasselbe: sie flacht die
Datei zu einer Tabelle ab. Eine Zeile pro Bauteil, Spalten für Typ, Name,
Geschoß, ein paar Property-Werte. Das ist eine gute Datenstruktur für die
Fragen, die man einem Bauteil einzeln stellt. Wie viele Fenster hat das
Gebäude. Welche Wände haben einen U-Wert unter 0,35. Zeig mir alles im
Erdgeschoß.

Nur ist fast keine Frage, die eine Architektin wirklich hat, eine Frage über ein
Bauteil. Es sind Fragen über eine **Anordnung**. In welcher Wand sitzt dieses
Fenster. Welchen Raum belichtet es. Was steht darüber. Wie weit ragt es vor.
Welche Räume trennt diese Wand.

Diese Beziehungen stehen in der IFC-Datei. Sie heißen `IfcRelFillsElement`,
`IfcRelVoidsElement`, `IfcRelSpaceBoundary`, `IfcRelAggregates`. Die Tabelle
liest genau eine davon — die Zuordnung zum Geschoß, weil daraus eine Spalte
wird — und wirft den Rest weg. Was der Agent dann in seinem Kontext hat, ist
eine Stückliste. Aus einer Stückliste ist ein Dachüberstand tatsächlich nicht
messbar. Der Agent hatte recht über das, was er sehen konnte.

## Der Reflex, dem wir nicht gefolgt sind

Der naheliegende Schluss lautet: mehr in den Kontext. Mehr Spalten, mehr
Property-Sets, die Geometrie irgendwie mit hinein.

Das skaliert nicht, und zwar nicht knapp. Ein Einfamilienhaus hat ein paar
hundert Bauteile; ein Bürogebäude hat sechsstellig viele Dreiecke. Aber der
eigentliche Einwand ist nicht die Größe. Er ist, dass eine Zahl im Kontext keine
Herkunft hat. Wenn im Prompt „15,42" steht, weiß das Modell nicht mehr, ob das
im Modell deklariert war, ob wir es gemessen haben, oder ob es geraten war. Und
es wird die Zahl trotzdem weitergeben, in einem Satz, der in allen drei Fällen
gleich gut klingt.

Wir haben stattdessen etwas anderes gebaut: **Werkzeuge, die messen, und einen
Antwortvertrag, der jede Zahl mit ihrer Herkunft ausliefert.**

## Drei Herkünfte, drei verschiedene Sätze

Jede Antwort trägt eine `provenance`, und die drei sind im Deutschen nicht
austauschbar:

| Herkunft | Wie es formuliert wird | Beispiel |
|---|---|---|
| `declared` | „Das Modell **deklariert** …" | U-Wert 0,236 W/m²K |
| `computed` | „**Gemessen** … (± Toleranz)" | Dachüberstand 0,647 m ± 5 mm |
| `inferred` | „**Vermutlich** …, bitte bestätigen" | „Wohnen" ist wohl ein Aufenthaltsraum |

Das ist keine Formalität. Wer eine Messung als Modellangabe ausgibt, legt einer
Architektin eine Zahl zur Unterschrift vor, deren Verantwortung sich still
verschoben hat. Ob ein Raum ein Aufenthaltsraum ist, ist eine **rechtliche**
Einstufung nach der Nutzung — keine geometrische Eigenschaft. Unser Werkzeug
kann aus dem Raumnamen einen Vorschlag machen. Es kann die Einstufung nicht
treffen, und es tut so, als könnte es das, sobald es sie ohne Konjunktiv
ausspricht.

## Der vierte Zustand, der uns am meisten wert ist

Es gibt einen vierten Fall, und der ist uns wichtiger als die drei anderen:
**`decidable: false`**.

Das heißt: die Frage ist sinnvoll gestellt, und *diese Datei* kann sie nicht
beantworten. Kein Fehler. Ein Befund über den Export.

```
NICHT ENTSCHEIDBAR: dieser Export liefert IfcGeometricRepresentationContext.TrueNorth
nicht. Das ist ein Befund über den EXPORT, nicht über das Gebäude.
Abhilfe: Nordrichtung im CAD setzen und neu exportieren.
```

Der letzte Satz ist der eigentliche Wert. Er ist eine Arbeitsanweisung. Die
Architektin weiß jetzt, welche eine Einstellung in Revit oder ArchiCAD ihr
morgen eine Antwort verschafft — statt zu erfahren, dass „die Auswertung nicht
möglich war".

Ein Werkzeug, das acht von zehn Fragen beantwortet und die anderen zwei
überspielt, ist schlechter als eines, das acht beantwortet und die zwei
benennt. Beim ersten kann niemand mehr sagen, welche zwei es waren.

## Was das Werkzeug ausdrücklich nicht tut

Das Prisma ist der Fall, an dem sich alles entscheidet.

Wir können jetzt das 45°-Prisma über der Fensterunterkante aufspannen, seitlich
um 30° schwenken, und jedes Bauteil finden, das hineinragt — mitsamt der Tiefe,
mit der es eindringt. Beim Beispielhaus ist das das Dach, 1,056 m tief.

Die naheliegende nächste Zeile wäre `compliant: false`. Wir schreiben sie nicht,
und das ist die wichtigste Entwurfsentscheidung im ganzen Projekt.

Denn ein geschnittenes Prisma **vergrößert nach OIB 3 die erforderliche
Lichteintrittsfläche**. Es verbietet das Fenster nicht. Wer aus „Prisma
geschnitten" ein „nicht erfüllt" macht, hat die Bestimmung nicht angewandt,
sondern übersprungen — und produziert einen Befund ohne Klausel dahinter, in
einem Dokument, das jemand unterschreibt.

Dieselbe Grenze zieht sich bis in die Signatur des Werkzeugs. `light_incidence`
**verweigert die Antwort ohne Winkelangabe**, statt stillschweigend 45
einzusetzen. 45° ist eine Tatsache über die *Vorschrift*, nicht über das
Gebäude. Ein Werkzeug, das den Winkel mitliefert, beantwortet eine Rechtsfrage,
die ihm nie gestellt wurde — und liefert klaglos OIB-Zahlen für ein Projekt, das
unter einem anderen Regelwerk steht.

Die Geometrie liefert Maße. Das Regelwerk fällt das Urteil. Zwischen beidem
verläuft eine Naht, und die halten wir sichtbar.

## Was uns ein zweiter Kernel gekostet und eingebracht hat

Wir haben die Operatoren zweimal gebaut: einmal auf einem WASM-Triangulator,
einmal auf IfcOpenShell mit OCCT. Das war teuer und es klingt nach Redundanz.

Beim ersten vollständigen Vergleich stimmten 40 von 41 Zahlen auf Mikrometer
überein. Die 41. war die lichte Raumhöhe. Die eine Engine lieferte 2,500 m — die
Höhe des Raumkörpers. Die andere warf Strahlen nach oben und fand die abgehängte
Decke bei 2,200 m.

Dreißig Zentimeter. Auf genau der Zahl, gegen die eine Mindestraumhöhe geprüft
wird. In der Richtung, die aus einem Nichtbestehen ein Bestehen macht.

Drei falsche Antworten gingen der richtigen voraus, jede aus einer anderen
Vorstellung davon, was „drüber" heißt: ungefilterte Strahlen trafen ein Sofa
(0,37 m), Strahlen ohne Möbel trafen eine Fensterbank (0,90 m), eine
Hüllkörper-Prüfung traf das Dach über dem ganzen Haus (1,74 m). Erst eine
**positive Liste** dessen, was überhaupt eine Decke sein kann, war richtig.

Kein noch so gründlicher Unit-Test hätte das gefunden. Er hätte bestätigt, dass
unsere Engine mit sich selbst einig ist. Nur ein zweiter Kernel stellt die
Frage, ob sie mit der Welt einig ist.

## Und die Antwort auf die ursprüngliche Frage?

Dieselbe Datei, dieselbe Frage, heute:

> Das Fenster `3cUkl…WcE` sitzt in der Außenwand `Wall-Ext_102Bwk` (aus
> `IfcRelVoidsElement` + `IfcRelFillsElement` abgeleitet — die Datei sagt es
> nirgends direkt). Es belichtet den Raum **Bedroom**; diese Beziehung ist aus
> der Geometrie gemessen, denn dieser Export enthält keine einzige
> `IfcRelSpaceBoundary`. Bodenfläche **15,42 m² (gemessen, ± 0,15 m²)**,
> Brüstung **0,900 m**, Sturz **2,110 m**. Die Fassade zeigt nach **Norden**.
> Der Dachüberstand beträgt **0,647 m (gemessen, ± 5 mm)**.
>
> Das 45°-Prisma mit 30° seitlicher Schwenkung ist **nicht frei**: das Dach ragt
> 1,056 m hinein.
>
> Das ist Geometrie, kein Befund. Nach OIB 3 vergrößert ein geschnittenes Prisma
> die erforderliche Lichteintrittsfläche — es verbietet das Fenster nicht.

Der Agent hatte die Vorschrift von Anfang an gekannt. Er kannte nur das Gebäude
nicht. Wir haben ihm nicht mehr Kontext gegeben, sondern Augen — und die
Gewohnheit, dazuzusagen, wie genau er hingesehen hat.

---

### Nachbemerkung: was noch nicht geht

Der Ehrlichkeit halber, weil ein Artikel über kalibrierte Blindheit schlecht
selbst blind enden kann:

- **Keine Besonnungsstudie.** Georeferenzierung macht einen Sonnenstand
  *möglich*; sie macht ihn nicht *gebaut*. Wir liefern das geometrische Prisma
  und keinen Sonnenvektor. Der ehrliche Zustand einer Fähigkeit, die es nicht
  gibt, ist Abwesenheit.
- **Nur Grundrisse, keine Schnitte.** `ifcopenshell.draw` kann Schnitte, aber sie
  brauchen Hidden-Line-Removal, und das lief bei einem Vier-Zimmer-Haus über
  zehn Minuten. Ein Werkzeug, das ein Gespräch aufhängt statt es zu beantworten,
  ist kein Werkzeug.
- **Große Modelle haben eine Grenze.** IfcOpenShell belegt das 20- bis
  143-fache der Dateigröße im Speicher, und der Faktor hängt an der
  geometrischen Komplexität, nicht an den Bytes. Wir lehnen zu große Modelle
  ausdrücklich ab, statt den Worker sterben zu lassen — und sagen dazu, dass es
  an der Datei liegt und nicht an einer Störung.
