"""Tests for `_make_chroma_client` — embedded vs shared-server selection.

Horizontal scaling swaps the embedded per-pod ChromaDB `PersistentClient` for a
shared `HttpClient` when `AIQ_CHROMA_URL`/`AIQ_CHROMA_HOST` is set. This test
pins that selection logic (and the URL parsing) without needing a real Chroma.
"""

from unittest import mock

import pytest
from knowledge_layer.llamaindex.adapter import _make_chroma_client

_CHROMA_ENV = ("AIQ_CHROMA_URL", "AIQ_CHROMA_HOST", "AIQ_CHROMA_PORT", "AIQ_CHROMA_SSL")


@pytest.fixture(autouse=True)
def _clear_chroma_env(monkeypatch):
    for var in _CHROMA_ENV:
        monkeypatch.delenv(var, raising=False)


def test_embedded_when_no_server_configured(monkeypatch, tmp_path):
    with mock.patch("chromadb.PersistentClient") as persistent, mock.patch("chromadb.HttpClient") as http:
        _make_chroma_client(str(tmp_path))
    http.assert_not_called()
    persistent.assert_called_once()
    assert persistent.call_args.kwargs["path"] == str(tmp_path)


def test_http_client_from_url(monkeypatch, tmp_path):
    monkeypatch.setenv("AIQ_CHROMA_URL", "http://chroma:8000")
    with mock.patch("chromadb.PersistentClient") as persistent, mock.patch("chromadb.HttpClient") as http:
        _make_chroma_client(str(tmp_path))
    persistent.assert_not_called()
    http.assert_called_once()
    kwargs = http.call_args.kwargs
    assert kwargs["host"] == "chroma"
    assert kwargs["port"] == 8000
    assert kwargs["ssl"] is False


def test_https_url_defaults_to_443_and_ssl(monkeypatch, tmp_path):
    monkeypatch.setenv("AIQ_CHROMA_URL", "https://vectors.example.com")
    with mock.patch("chromadb.HttpClient") as http:
        _make_chroma_client(str(tmp_path))
    kwargs = http.call_args.kwargs
    assert kwargs["host"] == "vectors.example.com"
    assert kwargs["port"] == 443
    assert kwargs["ssl"] is True


def test_host_port_env(monkeypatch, tmp_path):
    monkeypatch.setenv("AIQ_CHROMA_HOST", "chroma")
    monkeypatch.setenv("AIQ_CHROMA_PORT", "9000")
    with mock.patch("chromadb.HttpClient") as http:
        _make_chroma_client(str(tmp_path))
    kwargs = http.call_args.kwargs
    assert kwargs["host"] == "chroma"
    assert kwargs["port"] == 9000
    assert kwargs["ssl"] is False
