-- Revert the card judgement to the body 0056 left behind.
--
-- Guarded on the md5 of the body 0058 wrote, so a row edited through the
-- dashboard after 0058 ran is left exactly as it is — the same rule the forward
-- migration follows, for the same reason. `created_by = 'system'` is kept as a
-- second gate for consistency with 0055 and 0057: the md5 is what actually
-- protects an edited body, since the dashboard patches `body` and never touches
-- `created_by`, but a row somebody re-created by hand should not be reverted
-- either.

UPDATE "platform_skills"
   SET "description" = 'Vor dem Emittieren einer Karte laden: welche der allgemeinen Karten eine gewöhnliche Antwort wirklich besser macht und welche sie nur ein zweites Mal erzählt — Urteilskarte gegen ersten Satz, wann Kernaussagen verdient sind, ein Hinweis pro Antwort, brauchbare Anschlussfragen, Bedingungsbaum gegen Tabelle gegen Vergleich, und wie viele Karten zu viele sind. Gilt für jede fachliche Antwort, nicht nur für lange.',
       "body" = '# Welche Karte eine gewöhnliche Antwort besser macht

Auf Deutsch, weil eine Anleitung für knappes Fachdeutsch, die selbst aus
englischen Aufzählungspunkten besteht, englische Aufzählungspunkte lehrt.

Eine Karte hat genau eine Aufgabe: dem Leser Arbeit abnehmen, die er sonst im
Kopf erledigt. Nimmt sie ihm keine ab, kostet sie ihn einen zweiten Blick auf
dasselbe. Welche Karte zu welchem Inhalt gehört, steht im Werkzeug; hier steht,
wann sie verdient ist.

## Urteilskarte und erster Satz: der Wert und der Satz

Der erste Satz der Antwort ist das Urteil — das ist gesetzt. Die Urteilskarte
stellt dasselbe Urteil groß darüber. Beides ohne Unterscheidung zu schreiben
heißt, die Antwort zweimal übereinander zu stellen.

Die Aufteilung: **die Karte trägt den WERT, die Prosa trägt den SATZ.** Ein Wert
ist etwas, das man abschreiben kann — eine Zahl, eine Klasse, ein Befund wie
„Nicht geregelt". Der Satz ist das, was diesen Wert qualifiziert: woran er
hängt, worauf er sich stützt, wo er kippt. Die Karte kann diesen Satz nicht
tragen, die Prosa kann den Wert nicht groß machen. Deshalb dürfen beide nie in
denselben Worten dastehen.

**Schlecht** — Karte und erster Satz sagen dasselbe:

> [Karte] Einstufung des Vorhabens — **Gebäudeklasse 4**
>
> Ihr Vorhaben fällt in die Gebäudeklasse 4.

**Gut** — die Karte zeigt, der Satz qualifiziert:

> [Karte] Einstufung des Vorhabens — **Gebäudeklasse 4**
>
> Gebäudeklasse 4, und maßgeblich dafür ist das Fluchtniveau, nicht die
> Geschoßzahl [1].

Die Probe geht in zwei Richtungen. Decken Sie die Karte zu — beantwortet der
erste Satz die Frage immer noch vollständig? Decken Sie den ersten Satz zu — hat
der Leser den Wert, weiß aber nicht, woran er hängt? Wenn beides zutrifft,
stimmt die Aufteilung.

Und die Richtung, die häufiger greift: **wo es keinen solchen Wert gibt, gibt es
keine Urteilskarte.** Eine Antwort, die auf „das hängt davon ab" hinausläuft,
hat kein Urteil zum Großziehen — sie hat einen Bedingungsbaum. Eine Antwort,
deren Kern ein Absatz ist, ebenso wenig: ein in die Karte gepresster Absatz ist
kein Urteil, sondern eine Überschrift, die zu viel behauptet.

Wenn Karte und Satz doch einmal wörtlich gleich geraten, streichen Sie **die
Karte**, nicht den Satz. Der Satz ist die Antwort, die Karte war nur ihre
Darstellung.

## Kernaussagen: nur wenn die Karte allein trägt

Die Probe ist hart und sie ist die einzige: **Ginge ein Leser, der NUR die
Kernaussagen liest, mit derselben Antwort weg wie einer, der die Prosa liest?**
Wenn ja, ist die Karte verdient. Wenn nein, fehlt ihr etwas — dann schreiben Sie
sie um, statt sie so zu emittieren.

Daraus folgt die Gegenprobe. Ist die Antwort kurz genug, dass die Prosa selbst
schon die Kernaussage ist, dann ist die Karte die Antwort ein zweites Mal. Drei
Sätze brauchen keine Zusammenfassung von drei Sätzen.

Verdient ist die Karte, wenn die Antwort mehrere voneinander unabhängige Züge
enthält — eine Einstufung, die daraus folgende Anforderung, die Ausnahme —, die
der Leser sonst aus verschiedenen Absätzen zusammensuchen müsste. Nicht verdient
ist sie, wenn die Punkte bloß die Gliederung der Antwort nachzeichnen.

**Schlecht** — die Punkte sind die Absatzanfänge:

> Rechtsgrundlage · Anwendung auf das Projekt · Einschränkungen · Fazit

**Gut** — jeder Punkt ist für sich eine Aussage:

> Maßgeblich ist das Fluchtniveau, nicht die Geschoßzahl · Die Einstufung
> entscheidet über die Trennwandanforderung · Für den Zubau gilt die Einstufung
> des Bestands

## Ein Hinweis, nicht zwei

Der Hinweiskasten wirkt nur, weil er das Einzige auf der Seite ist, das schwerer
wiegt als der Absatz daneben. Ein zweiter nimmt beiden genau diese Eigenschaft:
der Leser muss nun selbst entscheiden, welcher der beiden der wichtige ist — und
diese Entscheidung war die Arbeit, die ihm der Kasten abnehmen sollte.

Verdient hat ihn der eine Satz, der ändert, was der Leser TUT: die Frist, die
Abweichung eines Bundeslandes, die Bedingung, die man beim Überfliegen
übersieht. Nicht die interessanteste Stelle der Antwort, sondern die
folgenreichste.

Schreiben Sie diesen Satz **einmal**. Steht er im Kasten, hat er im Absatz
nichts mehr verloren — die Herleitung bleibt in der Prosa, die Konsequenz steht
im Kasten. Ein Kasten, der einen Satz wiederholt, den der Leser zwei Zeilen
vorher schon gelesen hat, liest sich als Nachdruck und nicht als Warnung.

Gibt es zwei Sätze dieser Art, ist einer davon in Wahrheit Teil der Antwort und
gehört in den ersten Absatz.

## Anschlussfragen: vier verschiedene Züge, nicht viermal derselbe

Zwei Eigenschaften entscheiden, ob die Menge gelesen wird. Jede Frage muss etwas
nennen, das DIESE Antwort eingeführt hat — den Begriff, den sie erklärt, die
Zahl, die sie genannt, die Ausnahme, die sie aufgemacht hat. Und die Fragen
müssen verschiedene ARTEN von nächstem Schritt sein, nicht eine Frage in vier
Formulierungen.

**Schlecht** — viermal derselbe Zug, an nichts verankert:

> Kannst du mehr zu Gebäudeklassen sagen?
> Was gilt sonst noch?
> Gibt es weitere Anforderungen?
> Erzähl mir mehr dazu.

Keine dieser Fragen nennt einen Begriff aus der Antwort, und alle vier heißen
„weiter so". Der Leser lernt daran, dass die Chips Dekoration sind, und liest
sie ab der zweiten Antwort nicht mehr — womit auch die guten Mengen danach
verloren sind.

**Gut** — vier verschiedene Züge, jeder verankert:

> Wie wird das Fluchtniveau gemessen?
> — tiefer bei einem Begriff, den diese Antwort eingeführt hat
>
> Ändert sich die Einstufung, wenn das Dachgeschoß ausgebaut wird?
> — enger auf dieses Projekt
>
> Was hätte für die nächstniedrigere Gebäudeklasse gegolten?
> — die Variante, die die Antwort ausgeschlossen hat
>
> Welche Nachweise verlangt die Einreichung dafür?
> — der nächste konkrete Schritt

Zwei gute Fragen sind besser als vier, von denen zwei Füllmaterial sind.

## Bedingungsbaum, typisierte Tabelle, Vergleich

Drei Karten sehen alle wie „eine Tabelle mit Fällen" aus und werden deshalb
verwechselt. Sie unterscheiden sich nicht in der Form, sondern darin, was der
Leser mit den Zeilen macht.

- **Bedingungsbaum** — eine Frage, mehrere Fälle, und genau **eine** Zeile gilt
  für dieses Projekt.
- **Typisierte Tabelle** — die Antwort IST eine Tabelle, und **alle** Zeilen
  gelten gleichzeitig.
- **Vergleich** — mehrere Varianten stehen gegeneinander, und der Leser **wählt
  eine** aus.

Die Probe in einem Satz: *Gilt eine Zeile, gelten alle, oder wird eine gewählt?*

Zwei häufige Fehlgriffe. Eine Aufzählung von Anforderungen, die sämtlich erfüllt
sein müssen, ist keine Abwägung — dafür gibt es die typisierte Tabelle oder die
Prüfliste, nicht den Vergleich. Und ein Bedingungsbaum mit genau einem Ast ist
kein Baum, sondern ein Satz.

Der Bedingungsbaum ist der Fall, in dem eine Karte am meisten leistet: „hängt
von der Gebäudeklasse ab" wird in Prosa zu einer Schachtelung, die der Leser
selbst wieder flach klopfen muss. Wo bekannt ist, welcher Ast für dieses Projekt
gilt, markieren Sie ihn — sonst ist die Karte eine Aufgabenstellung und keine
Antwort.

## Normenkette: wenn die Bindung selbst der Inhalt ist

Die Normenkette ist keine Quellenliste. Sie ist die Karte für den Fall, dass die
eigentliche Frage nicht „was gilt" lautet, sondern „warum gilt das überhaupt für
mich" — wenn die Antwort also über mehrere Ränge läuft und der Unterschied
zwischen dem, was bindet, und dem, was nur auslegt, selbst zum Inhalt gehört.

Das Signal ist ein Satz in Ihrer eigenen Antwort: „bindend ist davon nur …",
„die ÖNORM gilt hier nur, weil …". Wenn Sie diesen Satz schreiben, zeichnet die
Karte, was er behauptet, und der Leser sieht das Gefälle, statt es aus einer
Aufzählung zu rekonstruieren.

Trägt dagegen eine einzige Vorschrift die Antwort, ist die Kette eine Kette mit
einem Glied. Dann gehört die Fundstelle in die Rechtsgrundlagen-Karte oder
schlicht in die Quellenangabe.

## Wie viele Karten zu viele sind

Zwei inhaltliche Karten sind die Obergrenze, und meistens ist eine die richtige
Zahl. Die Anschlussfragen zählen nicht dagegen: sie wiederholen nichts aus der
Antwort und stehen ohnehin ganz am Schluss.

Eine realistische Vollausstattung für eine lange Antwort ist damit: Urteilskarte
oben, eine Karte für den Kern, Anschlussfragen unten. Alles darüber macht die
Seite zu einer Übersicht, durch die der Leser scrollt, um die Antwort zu finden,
nach der er gefragt hat.

Die abschließende Probe: **Löschen Sie gedanklich alle Karten und lesen Sie die
Antwort.** Beantwortet sie die Frage vollständig? Wenn nicht, haben die Karten
Inhalt getragen, den die Prosa dem Leser schuldet — dann gehört er zurück in den
Text, und die Karte zeigt ihn nur noch. Eine Karte ergänzt eine vollständige
Antwort; sie ist nie ein Stück davon, das woanders hingerutscht ist.',
       "updated_at" = now()
 WHERE "name" = 'piloti-cards'
   AND "created_by" = 'system'
   AND md5("platform_skills"."body") = 'e209638994d1aa438df214a7aecd9072';  -- pragma: allowlist secret
