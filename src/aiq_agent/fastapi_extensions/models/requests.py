# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Request and response models for knowledge API endpoints."""

from typing import Any

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field


class CreateCollectionRequest(BaseModel):
    """Request body for creating a collection."""

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "name": "research-papers",
                    "description": "Collection of ML research papers",
                    "metadata": {},
                }
            ]
        }
    )

    name: str = Field(..., description="Unique collection name")
    description: str | None = Field(None, description="Human-readable description")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Backend-specific metadata")


class DeleteFilesRequest(BaseModel):
    """Request body for batch file deletion."""

    model_config = ConfigDict(json_schema_extra={"examples": [{"file_ids": ["file_abc123", "file_def456"]}]})

    file_ids: list[str] = Field(..., description="List of file IDs to delete")


class IngestRequest(BaseModel):
    """Request body for URL-based ingestion."""

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "file_ref": "https://minio.example.com/bucket/key?X-Amz-Signature=...",
                    "collection": "proj_abc123",
                    "document_id": "550e8400-e29b-41d4-a716-446655440000",
                }
            ]
        }
    )

    file_ref: str = Field(..., description="Presigned URL or file reference to download")
    collection: str = Field(..., description="Target collection name")
    document_id: str | None = Field(None, description="Optional document tracking ID")


class UploadResponse(BaseModel):
    """Response for document upload (async operation)."""

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "job_id": "job_abc123",
                    "file_ids": ["file_abc123"],
                    "message": "Ingestion job submitted for 1 file(s)",
                }
            ]
        }
    )

    job_id: str = Field(..., description="Job ID for polling ingestion status")
    file_ids: list[str] = Field(default_factory=list, description="IDs of uploaded files")
    message: str | None = Field(None, description="Status message")
