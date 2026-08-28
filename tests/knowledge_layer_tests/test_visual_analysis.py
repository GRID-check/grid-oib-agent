"""Unit tests for the domain-neutral visual extraction kernel.

Three things are under test and they are deliberately separable:

- ``visual_domains`` — the vocabulary, as data. A domain is added here and
  nothing else changes.
- ``visual_analysis`` — the kernel: JSON Schema, prompt, parser, renderer,
  chunk payloads. It never names a room or a floor plan.
- the adapter seams — that a rendered page, a raster embedded in a PDF and an
  uploaded image file are all understood by the SAME analysis.
"""

import json
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import visual_analysis as va
from knowledge_layer.llamaindex import visual_domains as vd


@pytest.fixture
def registry():
    return vd.resolve_registry("architecture,general")


def _reply(segments, document=None):
    return json.dumps({"segments": segments, "document": document or {}})


#: One sheet carrying a plan, a section, a chart and a photo — the case the
#: whole per-segment design exists for.
_MIXED_SHEET = _reply(
    [
        {
            "domain": "architecture",
            "segment_type": "floor_plan",
            "title": "EG",
            "scale": "1:100",
            "summary": "Regelgeschoss mit vier Wohneinheiten.",
            "entities": [
                {"name": "Atelier", "category": "space", "role": "Arbeiten", "measure": "24,5 m²"},
                {"name": "Wärmepumpe", "category": "services"},
                {"name": "Stahlbeton", "category": "material"},
            ],
            "compositions": [
                {
                    "component": "Außenwand",
                    "layers": [{"material": "Stahlbeton", "thickness": "20 cm", "function": "tragend"}],
                }
            ],
            "states": [{"element": "Bestandsmauer", "state": "existing"}],
            "quantities": [
                {
                    "object": "Bausubstanz erhalten",
                    "property": "Anteil",
                    "value": "71",
                    "unit": "%",
                    "source": "text",
                    "confidence": "high",
                },
                # Meaningless without an object — the failure the schema exists
                # to prevent.
                {"object": None, "property": "x", "value": "9"},
            ],
            "relations": [{"subject": "Rampe", "relation": "verbindet", "object": "Hof und Dach"}],
            "annotations": ["5,40"],
            "bbox": [0.05, 0.1, 0.5, 0.9],
            "source": "visual",
            "confidence": "medium",
        },
        {"domain": "architecture", "segment_type": "section", "scale": "1:50", "summary": "Querschnitt."},
        {
            "domain": "architecture",
            "segment_type": "diagram",
            "summary": "Energiebedarf je Variante.",
            "quantities": [{"object": "Variante A", "property": "Heizwärmebedarf", "value": "38", "unit": "kWh/m²a"}],
        },
        {
            "domain": "general",
            "segment_type": "photo",
            "summary": "Baustellenfoto mit Kran.",
            "entities": [{"name": "Kran", "category": "object"}],
        },
    ],
    {"title": "Wohnbau Nord", "subtitle": "Transformation", "summary": "Plansatz.", "slogans": ["ABRISS STOPPEN"]},
)


class TestDomainRegistry:
    def test_resolves_the_requested_domains_in_order(self):
        assert vd.resolve_registry("architecture,general").domain_ids == ("architecture", "general")

    def test_the_fallback_domain_is_always_enabled(self):
        # A segment falls back to it, so a deployment cannot switch it off.
        assert vd.FALLBACK_DOMAIN_ID in vd.resolve_registry("architecture").domain_ids

    def test_unknown_ids_are_skipped_rather_than_fatal(self):
        # A typo in one deployment's env must not fail every upload there.
        assert vd.resolve_registry("architecture,nonsense").domain_ids == ("architecture", "general")
        # Nothing recognisable still yields a usable vocabulary.
        assert vd.resolve_registry("nonsense").domain_ids == ("general",)
        # Unset falls back to the deployment default, not to nothing.
        assert vd.resolve_registry("").domain_ids == vd.resolve_registry(None).domain_ids

    def test_identity_names_the_enabled_set_and_its_contents(self, registry):
        assert registry.id == "architecture+general"
        assert registry.fingerprint == f"architecture+general@{registry.content_hash}"
        assert va.cache_prompt_type(registry) == f"visual:v{va.SCHEMA_VERSION}:{registry.fingerprint}"
        # Enabling a domain must not serve the other set's categories.
        assert va.cache_prompt_type(vd.resolve_registry("general")) != va.cache_prompt_type(registry)

    def test_editing_a_terms_wording_moves_the_content_hash(self, registry):
        # The id names WHICH domains are on; the hash names what they say. The
        # difference is invisible while the vocabulary is code and total the
        # moment it is editable: a renamed category changes what the model is
        # asked to look for, and a cache keyed on the id alone would serve the
        # old reading for the whole TTL.
        import dataclasses

        edited = dataclasses.replace(
            vd.ARCHITECTURE,
            entity_categories=tuple(
                dataclasses.replace(category, label="Rooms and uses") if category.key == "space" else category
                for category in vd.ARCHITECTURE.entity_categories
            ),
        )
        moved = vd.DomainRegistry((edited, vd.GENERAL))

        assert moved.id == registry.id
        assert moved.content_hash != registry.content_hash

    def test_a_deprecated_term_still_resolves_but_is_not_offered(self):
        import dataclasses

        retired = dataclasses.replace(
            vd.ARCHITECTURE,
            entity_categories=(
                *vd.ARCHITECTURE.entity_categories,
                vd.EntityCategory("old_term", "Old term", status=vd.DEPRECATED, replaced_by="space"),
            ),
        )
        one = vd.DomainRegistry((retired,))

        # Withheld from the model, so nothing new is written under it…
        assert "old_term" not in one.category_keys()
        # …but still resolvable, so a record extracted under it keeps rendering.
        assert "old_term" in retired.category_keys
        assert "old_term" not in va.build_prompt(one)

    def test_a_segment_types_role_decides_the_content_type(self, registry):
        assert registry.content_type_for([{"domain": "architecture", "segment_type": "floor_plan"}]) == "drawing"
        assert registry.content_type_for([{"domain": "architecture", "segment_type": "diagram"}]) == "chart"
        assert registry.content_type_for([{"domain": "general", "segment_type": "photo"}]) == "image"

    def test_a_mixed_sheet_is_typed_by_the_reader_came_for_it(self, registry):
        # A plan sheet carrying a chart and a photo is still a plan sheet.
        mixed = [
            {"domain": "general", "segment_type": "photo"},
            {"domain": "architecture", "segment_type": "diagram"},
            {"domain": "architecture", "segment_type": "floor_plan"},
        ]
        assert registry.content_type_for(mixed) == "drawing"
        # …but a photo sheet carrying a small diagram is a chart, not a drawing.
        assert registry.content_type_for(mixed[:2]) == "chart"


class TestJsonSchema:
    """The schema is a standalone artifact: it is what a provider's structured
    decoding is handed, and what the prompt's shape is derived from."""

    def test_conforms_to_the_strict_structured_output_subset(self, registry):
        schema = va.json_schema(registry)

        def check(node):
            if node.get("type") == "object" or "properties" in node:
                assert node.get("additionalProperties") is False
                # Strict mode requires every property to be listed as required;
                # optionality is carried by the type union instead.
                assert set(node.get("required", [])) == set(node["properties"])
                for child in node["properties"].values():
                    check(child)
            if "items" in node:
                check(node["items"])

        check(schema)

    def test_declares_the_enabled_vocabulary_as_enums(self, registry):
        segment = va.json_schema(registry)["properties"]["segments"]["items"]
        assert set(segment["properties"]["domain"]["enum"]) == {"architecture", "general"}
        assert "floor_plan" in segment["properties"]["segment_type"]["enum"]
        assert "space" in segment["properties"]["entities"]["items"]["properties"]["category"]["enum"]

    def test_does_not_attempt_conditional_validation(self, registry):
        # "a category must belong to the segment's domain" is deliberately NOT
        # expressed here — the strict subsets reject if/then — so the parser
        # owns that check. A schema that grew one would silently stop being
        # accepted by providers.
        rendered = json.dumps(va.json_schema(registry))
        for unsupported in ('"if"', '"then"', '"allOf"', '"oneOf"', '"$ref"'):
            assert unsupported not in rendered

    def test_the_prompt_shape_is_derived_from_the_schema(self, registry):
        # One source of truth: a field added to the schema shows up in the
        # prompt without anyone remembering to add it there too.
        schema = va.json_schema(registry)
        schema["properties"]["segments"]["items"]["properties"]["invented_field"] = {
            "type": "string",
            "description": "only in this copy",
        }
        assert "invented_field" in va._sketch(schema)

    def test_the_prompt_states_the_rules_the_parser_depends_on(self, registry):
        prompt = va.build_prompt(registry)
        # Contract, not prose: the shared rules, the per-domain vocabularies,
        # and the instruction that keeps free text searchable in its own
        # language.
        for token in ("segments", "quantities", "relations", "compositions", "bbox", "confidence", "watermark"):
            assert token in prompt
        assert "architecture" in prompt and "floor_plan" in prompt and "space" in prompt
        assert "LANGUAGE OF THE DOCUMENT" in prompt
        # It must stay affordable to send with every image.
        assert len(prompt) < 12000


class TestParsing:
    def test_parses_a_mixed_sheet_into_per_domain_segments(self, registry):
        analysis = va.parse_visual_analysis(_MIXED_SHEET, registry)

        assert [(s["domain"], s["segment_type"]) for s in analysis["segments"]] == [
            ("architecture", "floor_plan"),
            ("architecture", "section"),
            ("architecture", "diagram"),
            ("general", "photo"),
        ]
        # Scale belongs to the segment, not to the image.
        assert [s["scale"] for s in analysis["segments"]] == ["1:100", "1:50", None, None]
        assert analysis["schema_version"] == va.SCHEMA_VERSION
        assert analysis["registry"] == registry.fingerprint

    def test_strips_fences_and_surrounding_prose(self, registry):
        wrapped = f"Sure, here you go:\n```json\n{_MIXED_SHEET}\n```\nHope that helps!"
        assert va.parse_visual_analysis(wrapped, registry) is not None

    def test_an_unknown_domain_falls_back_rather_than_being_dropped(self, registry):
        analysis = va.parse_visual_analysis(
            _reply([{"domain": "electrical", "segment_type": "schematic", "summary": "A schematic."}]), registry
        )
        segment = analysis["segments"][0]
        assert segment["domain"] == "general"
        # Re-filing under a domain the model did not choose would be worse than
        # admitting the type is unknown.
        assert segment["segment_type"] == "other"
        assert segment["summary"] == "A schematic."

    def test_an_unknown_category_is_filed_not_lost(self, registry):
        analysis = va.parse_visual_analysis(
            _reply(
                [
                    {
                        "domain": "architecture",
                        "segment_type": "floor_plan",
                        "entities": [{"name": "Nordlicht", "category": "quantum_flux"}],
                    }
                ]
            ),
            registry,
        )
        # The thing WAS recognised; dropping it because the model coined a word
        # is the worse failure.
        assert analysis["segments"][0]["entities"] == [
            {"name": "Nordlicht", "category": "other", "role": None, "measure": None}
        ]

    def test_a_state_outside_the_domains_vocabulary_is_dropped(self, registry):
        analysis = va.parse_visual_analysis(
            _reply(
                [
                    {
                        "domain": "architecture",
                        "segment_type": "floor_plan",
                        "summary": "s",
                        "states": [{"element": "Wand", "state": "existing"}, {"element": "X", "state": "levitating"}],
                    }
                ]
            ),
            registry,
        )
        assert analysis["segments"][0]["states"] == [{"element": "Wand", "state": "existing"}]

    def test_drops_a_number_that_carries_no_meaning(self, registry):
        analysis = va.parse_visual_analysis(_MIXED_SHEET, registry)
        quantities = analysis["segments"][0]["quantities"]
        assert len(quantities) == 1
        assert quantities[0]["object"] == "Bausubstanz erhalten"
        assert quantities[0]["source"] == "text"

    def test_a_numeric_vocabulary_term_is_not_a_term(self, registry):
        analysis = va.parse_visual_analysis(
            _reply([{"domain": "architecture", "segment_type": 42, "summary": "s"}]), registry
        )
        assert analysis["segments"][0]["segment_type"] == "other"

    def test_bbox_is_clamped_or_dropped_never_repaired(self, registry):
        def bbox_of(value):
            analysis = va.parse_visual_analysis(
                _reply([{"domain": "architecture", "segment_type": "floor_plan", "summary": "s", "bbox": value}]),
                registry,
            )
            return analysis["segments"][0]["bbox"]

        assert bbox_of([0.05, -0.1, 0.55, 1.7]) == [0.05, 0.0, 0.55, 1.0]
        for malformed in ([0.5, 0.1, 0.4, 0.9], [0.1, 0.2, 0.3], "top left", None):
            assert bbox_of(malformed) is None

    def test_caps_a_runaway_reply(self, registry):
        analysis = va.parse_visual_analysis(
            _reply([{"domain": "general", "segment_type": "photo", "summary": f"p{i}"} for i in range(40)]), registry
        )
        assert len(analysis["segments"]) == va._MAX_SEGMENTS

    def test_returns_none_when_there_is_nothing_usable(self, registry):
        for reply in (None, "", "ZEICHNUNGSTYP: schnitt", '{"segments": []}', '{"segments": "broken"'):
            assert va.parse_visual_analysis(reply, registry) is None
        # A segment with no type signal and no content is model noise.
        assert va.parse_visual_analysis(_reply([{"domain": "general", "segment_type": "other"}]), registry) is None


class TestRendering:
    def test_states_every_populated_category_under_its_domains_label(self, registry):
        analysis = va.parse_visual_analysis(_MIXED_SHEET, registry)
        text = va.render_segment_text(analysis["segments"][0], registry)

        assert text.startswith("Floor plan — EG (scale 1:100)")
        for expected in (
            "Spaces and uses: Atelier (Arbeiten, 24,5 m²)",
            "Building services: Wärmepumpe",
            "Materials: Stahlbeton",
            "Build-up Außenwand: Stahlbeton 20 cm (tragend)",
            "State: Bestandsmauer: existing",
            "Figure: Bausubstanz erhalten — Anteil: 71 %",
            "Relation: Rampe → verbindet → Hof und Dach",
            "Source: visual, Confidence: medium",
        ):
            assert expected in text

    def test_labels_are_english_but_values_keep_the_documents_language(self, registry):
        # The labels are business logic; the values are what a German query has
        # to match lexically.
        analysis = va.parse_visual_analysis(_MIXED_SHEET, registry)
        text = va.render_segment_text(analysis["segments"][0], registry)
        assert "Wärmepumpe" in text and "Regelgeschoss" in text

    def test_a_general_domain_segment_reads_in_its_own_words(self, registry):
        analysis = va.parse_visual_analysis(_MIXED_SHEET, registry)
        text = va.render_segment_text(analysis["segments"][3], registry)
        assert text.startswith("Photo")
        assert "Objects: Kran" in text

    def test_the_watermark_never_reaches_indexed_text(self, registry):
        analysis = va.parse_visual_analysis(
            _reply(
                [{"domain": "architecture", "segment_type": "floor_plan", "summary": "Ein Grundriss."}],
                {"summary": "Ein Grundriss.", "watermark": "VECTORWORKS EDUCATIONAL VERSION"},
            ),
            registry,
        )
        assert "VECTORWORKS" not in va.render_analysis_text(analysis, registry).upper()


class TestSegmentPayloads:
    def test_one_chunk_per_segment_each_with_its_own_type_and_scale(self, registry):
        payloads = va.segment_payloads(va.parse_visual_analysis(_MIXED_SHEET, registry), registry)

        assert [p["drawing_type"] for p in payloads] == ["floor_plan", "section", "diagram", "photo"]
        assert [p["drawing_scale"] for p in payloads] == ["1:100", "1:50", "", ""]
        assert [p["segment_index"] for p in payloads] == [0, 1, 2, 3]
        assert all(p["segment_count"] == 4 for p in payloads)

    def test_document_facts_ride_on_the_first_chunk_only(self, registry):
        payloads = va.segment_payloads(va.parse_visual_analysis(_MIXED_SHEET, registry), registry)
        # Repeating the title block on every chunk would let one project-name
        # query retrieve four near-identical chunks from one sheet.
        assert "Wohnbau Nord" in payloads[0]["text"]
        assert not any("Wohnbau Nord" in p["text"] for p in payloads[1:])

    def test_the_full_structure_round_trips_on_the_chunk(self, registry):
        payloads = va.segment_payloads(va.parse_visual_analysis(_MIXED_SHEET, registry), registry)
        data = json.loads(payloads[3]["drawing_data"])
        assert data["schema_version"] == va.SCHEMA_VERSION
        assert data["registry"] == registry.fingerprint
        assert data["segment"]["domain"] == "general"
        assert data["document"]["title"] == "Wohnbau Nord"


class TestLegacyFields:
    def test_flattens_onto_the_shape_pre_schema_consumers_read(self, registry):
        fields = va.legacy_fields(va.parse_visual_analysis(_MIXED_SHEET, registry))

        assert fields["drawing_type"] == "floor_plan, section, diagram, photo"
        assert fields["scale"] == "1:100, 1:50"
        assert fields["title"] == "Wohnbau Nord"
        assert "Bausubstanz erhalten" in fields["dimensions"]
        assert fields["materials"] == "Stahlbeton"
        assert fields["summary"] == "Plansatz."

    def test_still_feeds_the_deterministic_summary_synthesiser(self, registry):
        fields = va.legacy_fields(va.parse_visual_analysis(_MIXED_SHEET, registry))
        summary = adapter._summary_from_drawing_fields([{"fields": fields}])
        assert summary.startswith("Plansatz.")


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


def _write_image(tmp_path, name="plan.webp", fmt="WEBP"):
    from PIL import Image

    path = tmp_path / name
    Image.new("RGB", (300, 200), "white").save(path, fmt)
    return str(path)


class TestOneAnalysisForEverySource:
    """The unification: a rendered page, a raster embedded in a PDF and an
    uploaded image file are understood by the SAME analysis. Embedded rasters
    used to get a generic caption prompt instead, so a scanned plan placed
    inside a PDF was indexed as one paragraph while the identical sheet as a
    vector page was indexed per drawing."""

    def _fields(self, registry):
        analysis = va.parse_visual_analysis(_MIXED_SHEET, registry)
        return {**va.legacy_fields(analysis), "analysis": analysis}

    def test_the_vlm_call_returns_a_typed_analysis(self):
        import openai

        with patch.object(openai, "OpenAI", _fake_openai(_MIXED_SHEET)):
            content_type, caption, fields = adapter.analyze_visual(b"img", vlm_api_key="k")

        assert content_type == "drawing"
        assert fields["analysis"]["segments"][3]["domain"] == "general"
        # The chunk body is rendered text, never raw JSON.
        assert "{" not in caption
        assert "Floor plan — EG (scale 1:100)" in caption

    def test_embedded_raster_and_rendered_page_run_the_same_analyser(self, monkeypatch, registry):
        from knowledge_layer.llamaindex import processing

        seen: list[bytes] = []

        def one_analyser(image_bytes, **kwargs):
            seen.append(image_bytes)
            return ("caption", self._fields(registry))

        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", one_analyser)
        monkeypatch.setattr(
            adapter,
            "_analyze_image_with_vlm",
            lambda *a, **k: (_ for _ in ()).throw(AssertionError("the caption prompt fired")),
        )

        images, pages = processing.enrich_vlm_batch(
            [{"image_bytes": b"raster", "page_number": 1, "image_index": 0, "format": "jpeg", "width": 1, "height": 1}],
            [{"image_bytes": b"page", "page_number": 2, "width": 2048, "height": 1400}],
            "model",
            "url",
            "key",
        )

        assert sorted(seen) == [b"page", b"raster"]
        assert images[0][1] == "drawing"
        assert pages[0]["content_type"] == "drawing"
        assert pages[0]["fields"]["analysis"] == images[0][0]["fields"]["analysis"]

    def test_an_embedded_raster_yields_per_segment_chunks(self, monkeypatch, registry):
        from knowledge_layer.llamaindex import processing

        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("c", self._fields(registry)))
        record = {
            "image_bytes": b"scanned-plan",
            "page_number": 7,
            "image_index": 1,
            "format": "jpeg",
            "width": 1200,
            "height": 900,
        }
        (image_results, _) = processing.enrich_vlm_batch([record], [], "model", "url", "key")
        enriched, content_type, caption = image_results[0]

        docs = adapter.visual_documents(
            content_type,
            caption,
            enriched["fields"],
            file_name="plan.pdf",
            file_size=1,
            page_number=7,
            extra_metadata={"image_index": 1},
        )
        assert [d.metadata["drawing_type"] for d in docs] == ["floor_plan", "section", "diagram", "photo"]
        assert all(d.metadata["page_label"] == "7" for d in docs)
        assert all(d.text.startswith("[DRAWING from page 7]") for d in docs)

    def test_a_standalone_image_takes_the_same_path(self, tmp_path, monkeypatch, registry):
        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("c", self._fields(registry)))

        docs = adapter._build_image_documents(_write_image(tmp_path), "plan.webp", 999, "webp", vlm_api_key="k")

        assert [d.metadata["drawing_type"] for d in docs] == ["floor_plan", "section", "diagram", "photo"]
        assert all(d.metadata["image_format"] == "webp" for d in docs)
        assert json.loads(docs[0].metadata["drawing_data"])["segment"]["segment_type"] == "floor_plan"

    def test_a_photo_needs_no_second_prompt(self, tmp_path, monkeypatch, registry):
        analysis = va.parse_visual_analysis(
            _reply([{"domain": "general", "segment_type": "photo", "summary": "Ein Baustellenfoto."}]), registry
        )
        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("c", {"analysis": analysis}))

        def forbidden(*a, **k):
            raise AssertionError("a parsed analysis must never spend a second VLM call")

        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", forbidden)

        docs = adapter._build_image_documents(
            _write_image(tmp_path, "foto.png", "PNG"), "foto.png", 5, "png", vlm_api_key="k"
        )
        assert len(docs) == 1
        assert docs[0].metadata["content_type"] == "image"

    def test_an_unparseable_reply_falls_back_to_the_caption_prompt(self, tmp_path, monkeypatch):
        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("just prose", {}))
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", lambda *a, **k: ("image", "Ein Baustellenfoto."))

        docs = adapter._build_image_documents(
            _write_image(tmp_path, "foto.png", "PNG"), "foto.png", 5, "png", vlm_api_key="k"
        )
        assert len(docs) == 1
        assert "Baustellenfoto" in docs[0].text

    def test_a_hard_failure_still_falls_back_before_giving_up(self, tmp_path, monkeypatch):
        # A provider error on the big structured prompt must not cost the file:
        # the smaller caption prompt is the last rung of the ladder.
        monkeypatch.setattr(
            adapter, "_analyze_drawing_page_with_vlm", lambda *a, **k: ("[Drawing - analysis failed: boom]", {})
        )
        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", lambda *a, **k: ("image", "Ein Foto."))

        docs = adapter._build_image_documents(
            _write_image(tmp_path, "foto.png", "PNG"), "foto.png", 5, "png", vlm_api_key="k"
        )
        assert len(docs) == 1
        assert "Ein Foto." in docs[0].text

    def test_an_undecodable_image_fails_the_file(self, tmp_path):
        path = tmp_path / "kaputt.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\nnot really a png")
        assert adapter._build_image_documents(str(path), "kaputt.png", 5, "png", vlm_api_key="k") is None


class TestVisualDocumentsBuilder:
    def test_a_caption_only_result_is_one_chunk_with_the_typed_prefix(self):
        docs = adapter.visual_documents(
            "chart", "Ein Balkendiagramm.", {}, file_name="f.pdf", file_size=3, page_number=2
        )
        assert len(docs) == 1
        assert docs[0].text == "[CHART from page 2]\n\nEin Balkendiagramm."
        assert docs[0].metadata["content_type"] == "chart"

    def test_extra_metadata_is_the_only_source_specific_part(self, registry):
        fields = {"analysis": va.parse_visual_analysis(_MIXED_SHEET, registry)}
        common = dict(file_name="f.pdf", file_size=3, page_number=1)
        page_docs = adapter.visual_documents("drawing", "c", fields, **common, extra_metadata={"image_width": 2048})
        raster_docs = adapter.visual_documents("drawing", "c", fields, **common, extra_metadata={"image_index": 4})

        assert [d.text for d in page_docs] == [d.text for d in raster_docs]
        assert page_docs[0].metadata["image_width"] == 2048
        assert raster_docs[0].metadata["image_index"] == 4
