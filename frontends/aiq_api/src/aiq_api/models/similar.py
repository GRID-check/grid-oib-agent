"""Request and response of ``POST /v1/collections/similar`` (similar passages, „Im Büro behandelt“)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic import model_validator


class SimilarPassageSource(BaseModel):
    """The passage a person is looking at. Its collection must be in the signed scope, like every searched one."""

    collection: str = Field(..., min_length=1, max_length=200, description="Collection the source document is in")
    file_name: str = Field(..., min_length=1, max_length=1000, description="The source document's file name there")
    text: str = Field("", max_length=8000, description="The passage text: a citation's snippet or the selection")
    page: int | None = Field(None, ge=1, description="1-based page the passage is on")
    chunk_id: str | None = Field(None, max_length=200, description="The stored chunk, when the caller knows it")
    kind: Literal["cited", "selected"] = Field(
        "selected",
        description=(
            "`cited`: retrieved text, matched to its stored chunk when it is one (no embedding). "
            "`selected`: a reader's selection, embedded as it is."
        ),
    )
    document_id: str | None = Field(None, max_length=100, description="The BFF's id of the source document")

    @model_validator(mode="after")
    def _has_a_vector(self) -> SimilarPassageSource:
        if not self.chunk_id and not self.text.strip():
            raise ValueError("a source needs a chunk_id or a text")
        return self


class SimilarPassagesRequest(BaseModel):
    """Which collections to search for passages like the source."""

    source: SimilarPassageSource
    collections: list[str] = Field(..., min_length=1, max_length=500, description="Collections to search")
    documents: int = Field(12, ge=1, le=50, description="Max documents in the answer, best first")
    passages_per_document: int = Field(3, ge=1, le=10, description="Max passages per document")
    snippet_max_chars: int = Field(320, ge=80, le=1500, description="Max characters of each passage's snippet")


class SimilarPassage(BaseModel):
    """One passage of a similar document."""

    chunk_id: str
    snippet: str = Field(..., description="The passage's opening, cut on a word boundary")
    page_number: int | None = None
    score: float = Field(..., description="Cosine similarity to the source passage, 0..1")


class SimilarDocument(BaseModel):
    """A document with passages like the source, its best passage first."""

    collection: str = Field(..., description="The searched collection the document is in")
    file_name: str
    passages: list[SimilarPassage]


class SimilarPassagesResponse(BaseModel):
    """Documents in ranking order (by each one's best passage); the source document is never among them."""

    documents: list[SimilarDocument] = Field(default_factory=list)
    origin: Literal["point", "embedded"] = Field(
        ..., description="`point`: the stored vector of the source chunk; `embedded`: the text was embedded"
    )
