-- The card judgement names the failure it exists to prevent.
--
-- Field evidence: „Wie läuft das Baubewilligungsverfahren in Wien ab?" came back
-- as a numbered prose list with no card, and the doctrine's trigger line is
-- almost those exact words (`a Verfahren, Ablauf or „wie läuft das ab" ->
-- process_map`). Asked two turns later, the model named the card correctly and
-- built a good one on the first attempt. So the card was recognised and not
-- emitted — which is a different fault from not knowing it exists, and nothing
-- in this body addressed it. Every section here answered "is this card
-- deserved?" and none answered "you have decided it is; now emit it".
--
-- Measured before rewriting, on the text the model actually sees: restraint
-- outweighed invitation 2.4 : 1 by tokens in this body (49 sentences to 12) and
-- 2.4 : 1 in the always-on `emit_card` doctrine. `follow_ups` is the proof that
-- the cost of a `describe_card` round-trip is not the cause — its shape rides
-- along inlined in `grid-cards`, so it costs nothing extra, and it did not
-- appear either. Its only instructions anywhere were three prohibitions.
--
-- Four changes, all of them tone and placement, none of them a weakened rule:
--
--   * A new section SECOND, before the nine that qualify: the expensive mistake
--     is the recognised card that never gets emitted, with the Wien Verfahren
--     as the Schlecht example and the naming rule as the Gut one. Second rather
--     than last because the reader of a long body applies its opening.
--   * `Anschlussfragen` now opens by saying the set is the regular close of a
--     subject-matter answer. Everything after it — anchored questions, four
--     different moves, two good beats four — is unchanged; what was missing was
--     the sentence saying the question is which, not whether.
--   * The Verfahrensablauf heading drops „nur wenn", which read as a gate on the
--     one card the observation caught going missing. The rule under it is
--     untouched, including never guessing `current_step`.
--   * „Wie viele Karten zu viele sind" becomes „Das Kartenbudget einer Antwort":
--     the same two-card number, stated as a budget to spend rather than a cap to
--     stay clear of. The zero cases and the deletion test below it stand.
--
-- Every honesty rule is carried over verbatim: no invented operand, no guessed
-- current step, no estimated number to make a calculation close, and Herkunft
-- und Toleranz copied rather than inferred. Getting more cards by getting more
-- invented numbers would be the one trade this product cannot make.
--
-- `grid-cards` is NOT widened. Inlining `process_map` costs +693 tokens on every
-- turn this skill loads — which is every answering turn — to save one
-- `describe_card` call on the minority that ask about a Verfahren, and
-- `follow_ups` already demonstrates that an inlined shape does not by itself
-- get a card emitted. The tool description says instead that looking a shape up
-- is never a reason to skip a card.
--
-- Guarded on the md5 of the body 0058 left behind, not on `created_by`: the
-- dashboard patches `body` and never touches `created_by`, so a hand-edited row
-- still reads `system` and must not be overwritten. `DO UPDATE` rather than a
-- bare `UPDATE` so a fresh install and a live database converge on one row.

INSERT INTO "platform_skills" ("name", "description", "body", "metadata", "published", "delivery", "created_by", "created_by_email")
VALUES (
  'piloti-cards',
  'Vor dem Emittieren einer Karte laden: warum die erkannte Karte trotzdem ausbleibt und wie man das abstellt, dazu welche der allgemeinen Karten eine gewöhnliche Antwort wirklich besser macht und welche sie nur ein zweites Mal erzählt — Urteilskarte gegen ersten Satz, wann Kernaussagen verdient sind, ein Hinweis pro Antwort, Anschlussfragen als Regelfall, Bedingungsbaum gegen Tabelle gegen Vergleich, der Rechenweg mit seinen Eingangswerten statt eines hingeschriebenen Ergebnisses, der Verfahrensablauf mit tragenden Stationen, und das Kartenbudget einer Antwort. Gilt für jede fachliche Antwort, nicht nur für lange.',
  '# Welche Karte eine gewöhnliche Antwort besser macht

Auf Deutsch, weil eine Anleitung für knappes Fachdeutsch, die selbst aus
englischen Aufzählungspunkten besteht, englische Aufzählungspunkte lehrt.

Eine Karte hat genau eine Aufgabe: dem Leser Arbeit abnehmen, die er sonst im
Kopf erledigt. Nimmt sie ihm keine ab, kostet sie ihn einen zweiten Blick auf
dasselbe. Welche Karte zu welchem Inhalt gehört, steht im Werkzeug; hier steht,
wann sie verdient ist — und warum sie so oft ausbleibt, obwohl sie es ist.

## Die erkannte Karte, die nicht kommt

Der teuerste Fehler mit Karten ist nicht die überflüssige Karte. Es ist die
erkannte: Die Frage trifft einen Auslöser, die passende Karte lässt sich
benennen, und die Antwort geht trotzdem als Fließtext hinaus. Nachträglich
gefragt, wird die Karte richtig benannt und auf Anhieb gut gebaut — sie war
also da, es fehlte nur der Werkzeugaufruf.

Deshalb: **Wenn Sie die Karte benennen können, emittieren Sie sie.** Der
Auslöser ist bereits die Entscheidung. Weggelassen wird eine Karte aus einem
der Gründe, die in dieser Anleitung stehen — nie, weil die Prosa schneller
fertig ist und nie, weil die Form der Karte erst nachgeschlagen werden müsste.
Ein `describe_card`-Aufruf ist billiger als die Karte, die nicht kommt.

**Schlecht** — „Wie läuft das Baubewilligungsverfahren in Wien ab?", beantwortet
als nummerierte Liste:

> 1. Einreichung bei der Baubehörde
> 2. Bauverhandlung
> 3. Baubewilligung
> 4. Baubeginnsanzeige
> 5. Fertigstellungsanzeige

Das ist der Auslöser für den Verfahrensablauf, Wort für Wort, und die Antwort
enthält die Karte nicht.

**Gut** — dieselben Stationen als Verfahrensablauf-Karte, jede mit dem, was sie
voraussetzt, was sie hervorbringt und wer zuständig ist, daneben ein Absatz
Prosa zu dem, woran das Verfahren in der Praxis hängt.

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

Eine fachliche Antwort schließt mit Anschlussfragen — das ist der Regelfall, nicht
die Kür. Zu entscheiden ist nicht ob, sondern welche.

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

## Rechenweg: Sie liefern die Werte, die Karte rechnet

Sobald eine Antwort eine Zahl **ausrechnet** statt sie nachzuschlagen, gehört der
Rechenweg auf eine Karte: das Schrittmaß, eine GFZ, eine Brandlast, der
Stellplatzbedarf, ein U-Wert aus den Widerständen. In Prosa muss die Leserin die
Rechnung nachvollziehen, bevor sie ihr glauben kann — auf der Karte prüft sie sie
Zeile für Zeile.

Sie liefern die **Eingangswerte, nicht das Ergebnis**. Jeder Operand bekommt seine
Bezeichnung, seinen Wert und seine Einheit; dazu die Operation und, wenn es eine
gibt, den Grenzwert aus der Bestimmung. Gerechnet, gerundet und beurteilt wird in
der Karte. Es gibt kein Feld für ein Ergebnis, und das ist Absicht: ein
hingeschriebenes Ergebnis, das nicht zu seinen eigenen Operanden passt, ist das
schlimmste Artefakt, das wir herstellen können — genau diese Karte landet als
Bildschirmfoto in der Einreichung.

Der Faktor gehört der **Regel**, nicht der Messung. Die 2 in „2 × Steigung +
Auftritt" steht in der Richtlinie; sie ist ein Faktor, kein zweiter Operand.
Braucht die Herleitung zwei Stufen, schreiben Sie zwei Schritte und lassen den
zweiten auf das Ergebnis des ersten verweisen — so bleibt sie prüfbar, statt zu
einer vorgerechneten Zahl zusammenzufallen.

Übernehmen Sie **Herkunft und Toleranz** genau so, wie `ifc_measure` sie gemeldet
hat. Die Karte trägt das Band durch die ganze Rechnung, und ein weggelassenes Band
macht das abgeleitete Ergebnis unehrlicher als die Messung, aus der es stammt.
Fehlt ein Wert, lassen Sie ihn leer — die Karte zeigt dann „nicht berechenbar".
Eine geschätzte Zahl, damit die Rechnung aufgeht, ist schlechter als gar keine
Karte.

Nicht für eine Zahl, die nur zitiert wird: wo nichts gerechnet wurde, gibt es
keinen Rechenweg, und eine Karte mit einem einzigen Operanden ist der Satz
daneben, zweimal gesetzt.

## Verfahrensablauf: die Stationen müssen etwas tragen

„Wie läuft das ab" ist eine der häufigsten Fragen überhaupt, und Einreichung →
Bauverhandlung → Baubewilligung → Baubeginnsanzeige → Fertigstellungsanzeige kommt
bisher als nummerierte Liste zurück. Die sagt die **Reihenfolge** und sonst nichts:
nicht, was ein Schritt voraussetzt, nicht, was er hervorbringt, und nicht, wo die
Leserin gerade steht.

Die Karte ist nur dann besser als die Liste, wenn die Schritte etwas tragen. Geben
Sie jedem, was vorliegen muss und was herauskommt — die Unterlagen und das Papier
—, dazu die Zuständigkeit und, wo die Bauordnung eine nennt, die Frist **so, wie
sie dort steht** („binnen sechs Wochen"), nie als errechnetes Datum. Ein Ablauf,
dessen Stationen nur Namen sind, ist die Liste mit Rahmen drumherum, und der Klick
öffnet sich ins Leere.

Den aktuellen Schritt markieren Sie **nur, wenn das Gespräch ihn hergibt**. Die
Karte leitet alles Übrige daraus ab: davor erledigt, danach bevorstehend. Geraten
heißt der Leserin zu sagen, sie habe eine Baubewilligung, die sie vielleicht nicht
hat. Ohne Angabe wird nichts markiert, und das ist das ehrliche Bild.

Ein Verfahren, kein Flussdiagramm: unter drei Stationen ist es kein Ablauf, über
acht liest es niemand mehr. Verzweigt sich das Verfahren nach einer Bedingung, ist
das ein Bedingungsbaum.

## Das Kartenbudget einer Antwort

Zwei inhaltliche Karten sind das Budget einer Antwort, und es ist zum Ausgeben
da: eine ist die übliche Zahl, drei sind zu viele, und keine ist richtig, wenn
die Antwort ein Satz ist oder die Karte ihn nur wiederholt. Die Anschlussfragen
zählen nicht dagegen: sie wiederholen nichts aus der Antwort und stehen ohnehin
ganz am Schluss.

Eine realistische Vollausstattung für eine lange Antwort ist damit: Urteilskarte
oben, eine Karte für den Kern, Anschlussfragen unten. Alles darüber macht die
Seite zu einer Übersicht, durch die der Leser scrollt, um die Antwort zu finden,
nach der er gefragt hat.

Die abschließende Probe: **Löschen Sie gedanklich alle Karten und lesen Sie die
Antwort.** Beantwortet sie die Frage vollständig? Wenn nicht, haben die Karten
Inhalt getragen, den die Prosa dem Leser schuldet — dann gehört er zurück in den
Text, und die Karte zeigt ihn nur noch. Eine Karte ergänzt eine vollständige
Antwort; sie ist nie ein Stück davon, das woanders hingerutscht ist.',
  '{"grid-agents": "shallow_researcher", "grid-hidden": "true", "grid-cards": "verdict_header,condition_tree,key_takeaways,callout,follow_ups"}'::jsonb,
  true,
  'standard',
  'system',
  NULL
)
ON CONFLICT ("name") DO UPDATE
  SET "description" = EXCLUDED."description",
      "body" = EXCLUDED."body",
      "updated_at" = now()
  WHERE md5("platform_skills"."body") = 'e209638994d1aa438df214a7aecd9072';  -- pragma: allowlist secret
