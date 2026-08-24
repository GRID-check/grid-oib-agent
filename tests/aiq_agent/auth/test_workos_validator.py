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
