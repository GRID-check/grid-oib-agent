"""Unit tests for the schema-v2 drawing extraction module (``drawing_analysis``).

Covers the module's whole surface as a pure library — parse, legacy-field
mapping, rendering, per-segment index payloads — plus the adapter integration
seams: the VLM call routing a v2 JSON reply through the structured path and a
non-JSON reply through the v1 fallback, and the versioned cache identity.
"""

import json
from unittest.mock import MagicMock
from unittest.mock import patch

from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import drawing_analysis as da

# A representative v2 reply: two segments on one sheet, each with its own
# scale, wrapped in a markdown fence with prose around it (models do both).
_V2_REPLY = (
    "Hier ist die Analyse:\n```json\n"
    + json.dumps(
        {
            "schema_version": 2,
            "segments": [
                {
                    "segment_type": "grundriss",
                    "title": "EG",
                    "scale": "1:100",
                    "levels": ["EG"],
                    "summary": "Grundriss des Erdgeschosses mit zentralem Atrium.",
                    "rooms": [{"name": "Atelier", "use": "Arbeiten", "area": "24,5 m²"}],
                    "circulation": ["Freitreppe"],
                    "structure": ["Stützenraster 5,4 m"],
                    "services": ["Wärmepumpe"],
                    "materials": ["Stahlbeton"],
                    "assemblies": [
                        {
                            "component": "Außenwand",
                            "layers": [{"material": "Stahlbeton", "thickness": "20 cm", "function": "tragend"}],
                        }
                    ],
                    "element_status": [{"element": "Bestandsmauer", "status": "bestand"}],
                    "quantities": [
                        {
                            "object": "Bausubstanz erhalten",
                            "property": "Anteil",
                            "value": "71",
                            "unit": "%",
                            "source": "text",
                            "confidence": "high",
                        },
                        # A bare number without an object carries no meaning
                        # and must be dropped, not indexed.
                        {"object": None, "property": "x", "value": "9"},
                    ],
                    "relations": [
                        {"subject": "Rampe", "relation": "verbindet", "object": "Hofebene und Dachlandschaft"}
                    ],
                    "annotations": ["5,40"],
                    "source": "visual",
                    "confidence": "medium",
                },
                {"segment_type": "schnitt", "scale": "1:50", "summary": "Querschnitt durch das Atrium."},
            ],
            "sheet": {
                "project_title": "Bildungscampus",
                "subtitle": "Transformation eines Bestandsbaus",
                "slogans": ["ABRISS STOPPEN"],
                "author": "N.N.",
                "institution": "TU Wien",
                "watermark": "VECTORWORKS EDUCATIONAL VERSION",
                "design_strategies": ["Bestandserhalt"],
                "process_steps": ["Abriss stoppen", "Bestand transformieren"],
                "summary": "Plansatz mit Grundriss 1:100 und Schnitt 1:50 eines Bildungsbaus.",
            },
        },
        ensure_ascii=False,
    )
    + "\n```"
)


class TestParseDrawingAnalysis:
    def test_parses_fenced_json_with_surrounding_prose(self):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        assert analysis is not None
        assert analysis["schema_version"] == da.SCHEMA_VERSION
        assert [s["segment_type"] for s in analysis["segments"]] == ["grundriss", "schnitt"]
        # Per-SEGMENT scale, the headline v2 capability.
        assert analysis["segments"][0]["scale"] == "1:100"
        assert analysis["segments"][1]["scale"] == "1:50"

    def test_meaningless_quantity_is_dropped(self):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        quantities = analysis["segments"][0]["quantities"]
        assert len(quantities) == 1
        assert quantities[0]["object"] == "Bausubstanz erhalten"
        assert quantities[0]["source"] == "text"

    def test_invalid_enums_normalised(self):
        reply = json.dumps(
            {
                "segments": [
                    {
                        "segment_type": "Floorplan",  # unknown → sonstiges
                        "summary": "Ein Plan.",
                        "element_status": [{"element": "Wand", "status": "vielleicht"}],
                        "source": "TEXT",  # case-normalised
                        "confidence": "certain",  # unknown → dropped
                    }
                ]
            }
        )
        analysis = da.parse_drawing_analysis(reply)
        segment = analysis["segments"][0]
        assert segment["segment_type"] == "sonstiges"
        assert segment["element_status"] == []
        assert segment["source"] == "text"
        assert segment["confidence"] is None

    def test_comma_string_accepted_for_list_field(self):
        reply = json.dumps({"segments": [{"segment_type": "grundriss", "materials": "Stahlbeton, Holz"}]})
        analysis = da.parse_drawing_analysis(reply)
        assert analysis["segments"][0]["materials"] == ["Stahlbeton", "Holz"]

    def test_content_free_noise_segment_dropped(self):
        reply = json.dumps({"segments": [{"segment_type": "sonstiges"}, {"segment_type": "schnitt", "summary": "S."}]})
        analysis = da.parse_drawing_analysis(reply)
        assert [s["segment_type"] for s in analysis["segments"]] == ["schnitt"]

    def test_non_json_and_empty_return_none(self):
        assert da.parse_drawing_analysis("ZEICHNUNGSTYP: schnitt\nMASSSTAB: 1:100") is None
        assert da.parse_drawing_analysis("") is None
        assert da.parse_drawing_analysis(None) is None
        assert da.parse_drawing_analysis('{"segments": []}') is None
        assert da.parse_drawing_analysis('{"segments": "kaputt"') is None  # truncated JSON

    def test_segment_cap(self):
        reply = json.dumps({"segments": [{"segment_type": "detail", "summary": f"D{i}"} for i in range(30)]})
        analysis = da.parse_drawing_analysis(reply)
        assert len(analysis["segments"]) == da._MAX_SEGMENTS


class TestLegacyFields:
    def test_maps_to_v1_shape(self):
        fields = da.legacy_fields(da.parse_drawing_analysis(_V2_REPLY))
        assert fields["drawing_type"] == "grundriss, schnitt"
        assert fields["scale"] == "1:100, 1:50"
        assert fields["title"] == "Bildungscampus"
        assert fields["watermark"] == "VECTORWORKS EDUCATIONAL VERSION"
        assert fields["summary"].startswith("Plansatz mit Grundriss")
        # Quantities keep their meaning in the flat rendering too.
        assert "Bausubstanz erhalten" in fields["dimensions"]

    def test_summary_falls_back_to_segment_detail(self):
        analysis = da.parse_drawing_analysis(
            json.dumps({"segments": [{"segment_type": "schnitt", "summary": "Querschnitt."}], "sheet": {}})
        )
        assert da.legacy_fields(analysis)["summary"] == "Querschnitt."

    def test_feeds_summary_from_drawing_fields(self):
        # The v1 summary synthesiser keeps working on v2-mapped fields.
        fields = da.legacy_fields(da.parse_drawing_analysis(_V2_REPLY))
        summary = adapter._summary_from_drawing_fields([{"fields": fields}])
        assert summary.startswith("Plansatz mit Grundriss")
        assert "VECTORWORKS" not in summary.upper()


class TestRendering:
    def test_segment_text_states_every_populated_category(self):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        text = da.render_segment_text(analysis["segments"][0], analysis["sheet"])
        assert text.startswith("Grundriss — EG (Maßstab 1:100)")
        for expected in (
            "Räume: Atelier (Arbeiten, 24,5 m²)",
            "Erschließung: Freitreppe",
            "Tragwerk: Stützenraster 5,4 m",
            "Gebäudetechnik: Wärmepumpe",
            "Bauteilaufbau Außenwand: Stahlbeton 20 cm (tragend)",
            "Bestand/Neu: Bestandsmauer: Bestand",
            "Kennwert: Bausubstanz erhalten — Anteil: 71 %",
            "Beziehung: Rampe → verbindet → Hofebene und Dachlandschaft",
            "Quelle: visuell erkannt, Konfidenz: mittel",
        ):
            assert expected in text
        # The watermark must never enter indexed text.
        assert "VECTORWORKS" not in text.upper()

    def test_analysis_text_includes_sheet_and_all_segments(self):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        text = da.render_analysis_text(analysis)
        assert "Projekt: Bildungscampus — Transformation eines Bestandsbaus" in text
        assert "Schlagzeilen: ABRISS STOPPEN" in text
        assert "Prozess: Abriss stoppen → Bestand transformieren" in text
        assert "Querschnitt durch das Atrium." in text


class TestSegmentPayloads:
    def test_one_payload_per_segment_with_own_metadata(self):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        payloads = da.segment_payloads(analysis)
        assert len(payloads) == 2
        assert payloads[0]["drawing_type"] == "grundriss"
        assert payloads[0]["drawing_scale"] == "1:100"
        assert payloads[1]["drawing_type"] == "schnitt"
        assert payloads[1]["drawing_scale"] == "1:50"
        assert [p["segment_index"] for p in payloads] == [0, 1]
        assert all(p["segment_count"] == 2 for p in payloads)

    def test_sheet_text_only_on_first_segment(self):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        payloads = da.segment_payloads(analysis)
        assert "Bildungscampus" in payloads[0]["text"]
        assert "Bildungscampus" not in payloads[1]["text"]

    def test_drawing_data_round_trips(self):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        data = json.loads(da.segment_payloads(analysis)[1]["drawing_data"])
        assert data["schema_version"] == da.SCHEMA_VERSION
        assert data["segment"]["segment_type"] == "schnitt"
        assert data["sheet"]["project_title"] == "Bildungscampus"


class _FakeCompletions:
    def __init__(self, reply):
        self._reply = reply

    def create(self, **kwargs):
        message = MagicMock()
        message.content = self._reply
        choice = MagicMock()
        choice.message = message
        choice.finish_reason = "stop"
        response = MagicMock()
        response.choices = [choice]
        return response


def _fake_openai(reply):
    class _FakeClient:
        def __init__(self, *args, **kwargs):
            self.chat = MagicMock()
            self.chat.completions = _FakeCompletions(reply)

    return _FakeClient


class TestAdapterIntegration:
    def test_v2_reply_yields_rendered_text_and_analysis(self):
        import openai

        with patch.object(openai, "OpenAI", _fake_openai(_V2_REPLY)):
            caption, fields = adapter._analyze_drawing_page_with_vlm(b"img", vlm_api_key="k")
        assert fields["drawing_type"] == "grundriss, schnitt"
        assert fields["analysis"]["segments"][1]["scale"] == "1:50"
        # The chunk body is rendered text, not raw JSON.
        assert "{" not in caption
        assert "Grundriss — EG (Maßstab 1:100)" in caption

    def test_non_json_reply_falls_back_to_v1(self):
        import openai

        legacy = "ZEICHNUNGSTYP: schnitt\nMASSSTAB: 1:50\nZUSAMMENFASSUNG: Ein Schnitt."
        with patch.object(openai, "OpenAI", _fake_openai(legacy)):
            caption, fields = adapter._analyze_drawing_page_with_vlm(b"img", vlm_api_key="k")
        assert caption == legacy
        assert fields == {"drawing_type": "schnitt", "scale": "1:50", "summary": "Ein Schnitt."}
        assert "analysis" not in fields

    def test_prompt_contract(self):
        # Contract, not prose: the prompt must demand JSON-only output, the
        # segment structure, and quantity/relation/provenance fields the
        # parser consumes; the watermark stays quarantined to its field.
        prompt = da.DRAWING_ANALYSIS_PROMPT
        for token in ("segments", "quantities", "relations", "assemblies", "element_status", "confidence", "watermark"):
            assert token in prompt
        assert "JSON" in prompt

    def test_cache_identity_is_versioned(self):
        assert da.CACHE_PROMPT_TYPE == f"drawing:v{da.SCHEMA_VERSION}"
        assert da.CACHE_PROMPT_TYPE != "drawing"  # v1 cache entries never match


class TestBbox:
    def test_valid_bbox_clamped_and_kept(self):
        reply = json.dumps(
            {"segments": [{"segment_type": "grundriss", "summary": "P.", "bbox": [0.05, -0.1, 0.55, 1.7]}]}
        )
        assert da.parse_drawing_analysis(reply)["segments"][0]["bbox"] == [0.05, 0.0, 0.55, 1.0]

    def test_degenerate_or_malformed_bbox_dropped(self):
        for bad in ([0.5, 0.1, 0.4, 0.9], [0.1, 0.2, 0.3], "links oben", None):
            reply = json.dumps({"segments": [{"segment_type": "grundriss", "summary": "P.", "bbox": bad}]})
            assert da.parse_drawing_analysis(reply)["segments"][0]["bbox"] is None


def _write_image(tmp_path, name="plan.webp", fmt="WEBP"):
    from PIL import Image

    path = tmp_path / name
    Image.new("RGB", (300, 200), "white").save(path, fmt)
    return str(path)


class TestStandaloneImageDrawingFirst:
    """Standalone plan exports (PNG/JPG/WebP) get the structured drawing
    analysis; photos and failed analyses fall back to the generic caption."""

    def test_drawing_image_yields_per_segment_documents(self, tmp_path, monkeypatch):
        analysis = da.parse_drawing_analysis(_V2_REPLY)
        fields = da.legacy_fields(analysis)
        fields["analysis"] = analysis
        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("caption", fields))

        docs = adapter._build_image_documents(_write_image(tmp_path), "plan.webp", 999, "webp", vlm_api_key="k")

        assert [d.metadata["drawing_type"] for d in docs] == ["grundriss", "schnitt"]
        assert all(d.metadata["content_type"] == "drawing" for d in docs)
        assert all(d.metadata["image_format"] == "webp" for d in docs)
        assert json.loads(docs[0].metadata["drawing_data"])["segment"]["segment_type"] == "grundriss"

    def test_photo_falls_back_to_generic_caption(self, tmp_path, monkeypatch):
        # The drawing analysis recognises nothing drawing-like…
        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("nur Prosa", {}))
        # …so the generic caption path takes over.
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", lambda *a, **k: ("image", "Ein Baustellenfoto."))

        path = _write_image(tmp_path, "foto.png", "PNG")
        docs = adapter._build_image_documents(path, "foto.png", 5, "png", vlm_api_key="k")

        assert len(docs) == 1
        assert docs[0].metadata["content_type"] == "image"
        assert "Baustellenfoto" in docs[0].text

    def test_sonstiges_only_analysis_is_not_a_drawing(self, tmp_path, monkeypatch):
        reply = json.dumps({"segments": [{"segment_type": "sonstiges", "summary": "Irgendwas."}]})
        analysis = da.parse_drawing_analysis(reply)
        fields = {"analysis": analysis, **da.legacy_fields(analysis)}
        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("c", fields))
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", lambda *a, **k: ("image", "Ein Poster."))

        path = _write_image(tmp_path, "p.png", "PNG")
        docs = adapter._build_image_documents(path, "p.png", 5, "png", vlm_api_key="k")

        assert len(docs) == 1
        assert docs[0].metadata["content_type"] == "image"

    def test_undecodable_image_returns_none(self, tmp_path):
        path = tmp_path / "kaputt.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\nnot really a png")
        assert adapter._build_image_documents(str(path), "kaputt.png", 5, "png", vlm_api_key="k") is None
