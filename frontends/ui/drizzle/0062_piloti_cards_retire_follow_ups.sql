-- The `follow_ups` card is retired; its craft section leaves the body with it.
--
-- The post-answer `follow_ups` STAGE now computes the next questions after the
-- answer is written, gated by deterministic Python instead of the answering
-- model's opinion of its own answer, and renders them BELOW the answer card
-- (`src/aiq_agent/stages/follow_ups.py`; docs/architecture/post-answer-stages.md
-- §7.10). The card stays a valid union member so every stored one keeps
-- rendering, but `SYSTEM_CARD_TYPES` now refuses a new one on all three emission
-- paths — so everything in this row that teaches the model to build one is
-- teaching a move it can no longer make.
--
-- Three removals, and each is dead weight for its own reason:
--
--   * „Anschlussfragen: vier verschiedene Züge, nicht viermal derselbe" — the
--     section, with its bad/good worked pair. It was mined into the stage's own
--     prompt before this migration (`stages/follow_ups.py`), so the judgement is
--     not lost, only moved to the surface that can still act on it.
--   * The two sentences in „Das Kartenbudget einer Antwort" that spend the
--     budget on a card the model cannot emit — the exemption („Die
--     Anschlussfragen zählen nicht dagegen") and the „Anschlussfragen unten" in
--     the worked full kit.
--   * `follow_ups` in `grid-cards`. That list is read twice: it is the author's
--     card preference AND it decides which shapes `_preferred_cards_block`
--     inlines. Leaving a retired name in it would be worse than untidy —
--     `preferred_cards` filters against the live model-facing catalog, so the
--     name would be silently dropped on every read and the seed would name a card
--     the runtime never sees, which is the exact drift
--     `test_seeded_grid_cards_survive_the_read_path` exists to catch.
--
-- WHAT IT RECOVERS, measured with tiktoken `cl100k_base` and not estimated from
-- characters. The shapes block goes from 2,157 tokens to 1,881 — `follow_ups`'s
-- shape plus the `FollowUp` building block only it referenced — on every turn
-- that delivers this body, which `delivery: standard` makes every research turn.
-- The body itself goes from 5,239 to 4,791, of which the craft section is 435.
-- Together: 724 tokens per research turn, against the 136 the always-on
-- `emit_card` description gives back on every chat turn.
--
-- The description reverts and advances with the body, as it has since 0060: the
-- L1 line names what the body teaches, and a description promising
-- „Anschlussfragen als Regelfall" over a body that no longer discusses them is
-- worse than either half alone.
--
-- Guarded on the md5 of the body 0060 wrote and 0061 left untouched, NOT on
-- `created_by` — the dashboard's update path patches `body` and never touches
-- `created_by`, so a hand-edited row still reads `system` and that column cannot
-- tell an owned row from an untouched one. A row whose prose somebody has
-- rewritten is theirs, card preferences included, and is left alone in both
-- directions. The guard also makes a second run a true no-op: after this
-- migration applies, `md5(body)` is no longer the hash below and the `DO UPDATE`
-- matches nothing.
--
-- The reversal is `0062_piloti_cards_retire_follow_ups.down.sql`, which restores
-- 0061's exact body, description and card list — and, because retiring the card
-- is what this whole change turns on, that rollback is only half the revert:
-- `follow_ups` has to come out of `SYSTEM_CARD_TYPES` with it, or the restored
-- list names a card the read path drops again.

INSERT INTO "platform_skills" ("name", "description", "body", "metadata", "published", "delivery", "created_by", "created_by_email")
VALUES (
  'piloti-cards',
  'Vor dem Emittieren einer Karte laden: warum die erkannte Karte trotzdem ausbleibt und wie man das abstellt, dazu welche der allgemeinen Karten eine gewöhnliche Antwort wirklich besser macht und welche sie nur ein zweites Mal erzählt — Urteilskarte gegen ersten Satz, wann Kernaussagen verdient sind, ein Hinweis pro Antwort, Bedingungsbaum gegen Tabelle gegen Vergleich samt der Vorfrage, ob überhaupt nur eine Zeile gelten kann, der Rechenweg mit seinen Eingangswerten statt eines hingeschriebenen Ergebnisses, der Verfahrensablauf mit tragenden Stationen, die Unterlagenliste als Liste von Zuständen, der Fristenlauf ohne errechnete Daten, die Auswirkung einer Änderung mit Fundstelle je Folge, und das Kartenbudget einer Antwort. Gilt für jede fachliche Antwort, nicht nur für lange.',
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

### Die Vorfrage zum Bedingungsbaum: kann mehr als eine Zeile gelten?
Bevor Sie einen Bedingungsbaum bauen, stellen Sie genau eine Frage: **Kann mehr
als eine Zeile gleichzeitig zutreffen?** Wenn ja, ist es nie ein Baum. Ein Baum
bedeutet, dass das Projekt in genau einem Fall steht — deshalb darf höchstens
ein Zweig als zutreffend markiert sein, und deshalb schreibt die Karte über den
markierten Zweig „für dieses Projekt gilt".
„Feuerwiderstand tragender Bauteile in GK 4" ist kein Baum: oberstes Geschoß,
sonstiges oberirdisches Geschoß und unterirdisches Geschoß gelten alle drei
zugleich, nur an verschiedenen Stellen desselben Gebäudes. Das ist eine
typisierte Tabelle mit den Spalten Lage, Anforderung und Fundstelle.
Drei gleichzeitig markierte Zweige sehen aus wie eine getroffene Entscheidung,
obwohl keine getroffen wurde — und das ist schlechter als gar keine Karte. Wenn
es wirklich ein Baum ist, Sie aber nicht wissen, welcher Fall gilt, markieren
Sie keinen: „ich weiß es nicht" ist eine Auskunft, geraten ist keine.

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

## Unterlagenliste: Zustände, nicht Namen
Die Frage „welche Unterlagen brauche ich für die Einreichung?" verlangt keine
Liste von Namen, sondern eine Liste von Zuständen: was immer verlangt wird, was
nur bei einer bestimmten Vorhabensart — und bei welcher —, wer es ausstellt,
und was der Leser davon schon in der Hand hat. Eine Aufzählung im Fließtext
trägt nichts davon; der Leser leitet es sich bei jedem Lesen neu aus den Sätzen
ringsum ab.
Setzen Sie `status` ausschließlich dort, wo das Gespräch es hergegeben hat:
Wenn jemand gesagt hat, der Energieausweis fehle noch, dann steht das in der
Karte — sonst bleibt das Feld leer und die Zeile liest sich als „nicht
bekannt". Die Karte zählt selbst zusammen, wie viele Unterlagen vorhanden,
fehlend und ungeklärt sind; ein geratener Status verfälscht daher nicht nur
seine Zeile, sondern auch die Bilanz darüber.
Eine bedingte Unterlage ohne Bedingung lassen Sie ganz weg — sie ist die
Fließtext-Aufzählung, nur mit einem Etikett darauf.

## Fristenlauf: die Reihenfolge ist die Auskunft
Eine einzelne Frist ist ein Hinweis. Ein Bauverfahren hat aber mehrere
hintereinander — Beschwerdefrist, Baubeginn, Geltungsdauer der Bewilligung,
Fertigstellungsanzeige —, und dann sind die Reihenfolge und das Ereignis, ab
dem jede Uhr läuft, die eigentliche Auskunft. Als vier Sätze Prosa muss der
Leser das selbst sortieren, und genau beim Sortieren passiert der Fehler.
Schreiben Sie jede Frist so, wie die Bestimmung sie formuliert — „binnen sechs
Wochen ab Zustellung" —, niemals als Datum: Wir kennen das Zustelldatum dieses
Projekts nicht, und ein falsches Datum auf einer Karte ist schlimmer als gar
keine Karte. Zu jeder Frist gehört, ab wann sie läuft; wissen Sie das nicht,
lassen Sie die Frist weg, statt sie ohne Anker hinzuschreiben.
Die Karte zeichnet die Reihenfolge, nicht die Dauer, und sagt das auch — vier
Wochen und vier Jahre liegen nicht auf derselben Zeitachse.

## Auswirkung einer Änderung: was ein Wechsel kostet
Das ist die Karte für die Frage, die beim Planen gestellt wird: „was passiert,
wenn das Fluchtniveau über 11 m geht?" Dann ändert sich die Gebäudeklasse, und
mit ihr der Feuerwiderstand, der zweite Fluchtweg und die Aufzugspflicht.
Verwechseln Sie das nicht mit dem Bedingungsbaum: Der Baum zeigt, in welchem
Fall das Projekt steht, diese Karte zeigt, was ein Wechsel kosten würde.
Nennen Sie die eine Größe, die sich bewegt, und darunter jede Folge einzeln —
mit ihrer eigenen Fundstelle, denn nach dieser Karte wird geplant, und eine
Folge, die niemand nachschlagen kann, ist eine Folge, nach der niemand handeln
kann; ohne Fundstelle lassen Sie sie weg.
Sagen Sie zu jeder Folge, ob sie verschärft oder gelockert wird, und scheuen
Sie „unverändert" nicht: Die Hälfte der Antwort auf „was ändert sich" besteht
darin, eine Anforderung zu nennen, deren Änderung man erwarten würde, und
festzuhalten, dass sie gleich bleibt. Den Ausgangswert setzen Sie nur, wenn das
Gespräch ihn hergegeben hat — die Frage liefert das Ziel, nicht den Stand.

## Das Kartenbudget einer Antwort

Zwei inhaltliche Karten sind das Budget einer Antwort, und es ist zum Ausgeben
da: eine ist die übliche Zahl, drei sind zu viele, und keine ist richtig, wenn
die Antwort ein Satz ist oder die Karte ihn nur wiederholt.

Eine realistische Vollausstattung für eine lange Antwort ist damit: Urteilskarte
oben und eine Karte für den Kern. Alles darüber macht die Seite zu einer
Übersicht, durch die der Leser scrollt, um die Antwort zu finden, nach der er
gefragt hat.

Die abschließende Probe: **Löschen Sie gedanklich alle Karten und lesen Sie die
Antwort.** Beantwortet sie die Frage vollständig? Wenn nicht, haben die Karten
Inhalt getragen, den die Prosa dem Leser schuldet — dann gehört er zurück in den
Text, und die Karte zeigt ihn nur noch. Eine Karte ergänzt eine vollständige
Antwort; sie ist nie ein Stück davon, das woanders hingerutscht ist.',
  '{"grid-agents": "shallow_researcher", "grid-hidden": "true", "grid-cards": "verdict_header,condition_tree,typed_table,key_takeaways,callout,process_map"}'::jsonb,
  true,
  'standard',
  'system',
  NULL
)
ON CONFLICT ("name") DO UPDATE
  SET "description" = EXCLUDED."description",
      "body" = EXCLUDED."body",
      "metadata" = EXCLUDED."metadata",
      "updated_at" = now()
  WHERE md5("platform_skills"."body") = '9662a746c7e877a70e5c814b4cbdecca';  -- pragma: allowlist secret
