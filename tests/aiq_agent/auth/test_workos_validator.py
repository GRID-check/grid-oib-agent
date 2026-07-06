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

"""Tests for WorkOS JWT validator configuration.

Module under test: src/aiq_agent/auth/workos_validator.py
"""

import os
from unittest.mock import patch

import pytest

from aiq_agent.auth.workos_validator import create_workos_validator


@patch.dict(os.environ, {"WORKOS_CLIENT_ID": "client_123"}, clear=True)
def test_create_workos_validator_configures_workos_jwks():
    """create_workos_validator returns a JWTValidator configured for WorkOS access tokens.

    AuthKit access tokens carry the client-scoped issuer
    (``https://api.workos.com/user_management/<client_id>``) and no ``aud``
    claim — verified against the live OIDC discovery document. A bare
    ``https://api.workos.com`` issuer or an enforced audience rejects every
    real token.
    """
    validator = create_workos_validator()

    assert validator.issuer_url == "https://api.workos.com/user_management/client_123"
    assert validator._jwks_uri == "https://api.workos.com/sso/jwks/client_123"
    assert validator.audience is None
    assert validator.algorithms == ["RS256"]


def test_create_workos_validator_requires_workos_client_id():
    """create_workos_validator raises when WORKOS_CLIENT_ID is not set."""
    with patch.dict(os.environ, {}, clear=True):
        with pytest.raises(KeyError, match="WORKOS_CLIENT_ID"):
            create_workos_validator()
