"""Tests for the shared message-content normalization helper."""

from aiq_agent.common import content_to_text


class _TextBlock:
    """A content block exposing ``.text`` as an attribute (not a dict)."""

    def __init__(self, text):
        self.text = text


class TestContentToText:
    """content_to_text flattens the several shapes ``message.content`` can take."""

    def test_string_content_unchanged(self):
        assert content_to_text("plain answer") == "plain answer"

    def test_empty_string_unchanged(self):
        assert content_to_text("") == ""

    def test_list_of_dict_blocks_flattened(self):
        content = [
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ]
        assert content_to_text(content) == "first\nsecond"

    def test_list_of_string_blocks_flattened(self):
        assert content_to_text(["a", "b"]) == "a\nb"

    def test_list_of_object_blocks_flattened(self):
        content = [_TextBlock("obj one"), _TextBlock("obj two")]
        assert content_to_text(content) == "obj one\nobj two"

    def test_mixed_and_untexty_blocks(self):
        content = [
            {"type": "text", "text": "keep"},
            {"type": "image", "url": "http://x"},  # no "text" -> skipped
            "raw",
        ]
        assert content_to_text(content) == "keep\nraw"

    def test_none_returns_empty_string(self):
        assert content_to_text(None) == ""

    def test_non_str_non_list_stringified(self):
        assert content_to_text(123) == "123"


class TestResponseText:
    """#653: the text of a model reply, whether its content is a string or a list of blocks."""

    BLOCKS = [
        {"type": "reasoning", "summary": []},
        {"type": "text", "text": '{"items": ['},
        {"type": "text", "text": '"a"]}'},
    ]

    def test_a_block_list_yields_the_text_blocks_joined(self):
        from langchain_core.messages import AIMessage

        from aiq_agent.common.message_utils import response_text

        assert response_text(AIMessage(content=self.BLOCKS)) == '{"items": ["a"]}'

    def test_every_shape_a_caller_meets(self):
        from langchain_core.messages import AIMessage

        from aiq_agent.common.message_utils import response_text

        assert response_text(AIMessage(content="plain")) == "plain"
        assert response_text({"content": "from a dict"}) == "from a dict"
        assert response_text("already text") == "already text"
        assert response_text(None) == ""
