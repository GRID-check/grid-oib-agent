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

"""WorkOS-specific JWT validator factory.

Returns a :class:`aiq_api.auth.JWTValidator` configured to verify WorkOS
access tokens against the WorkOS JWKS endpoint for a given client ID.
"""

import os

from aiq_api.auth import JWTValidator


def create_workos_validator() -> JWTValidator:
    """Create a ``JWTValidator`` configured for WorkOS access tokens.

    Reads ``WORKOS_CLIENT_ID`` from the environment and points the validator at
    the WorkOS issuer and client-specific JWKS URI.

    Returns:
        A :class:`JWTValidator` with issuer ``https://api.workos.com``,
        audience equal to the client ID, and RS256 signature verification.

    Raises:
        KeyError: If ``WORKOS_CLIENT_ID`` is not set in the environment.
    """
    client_id = os.environ["WORKOS_CLIENT_ID"]
    return JWTValidator(
        issuer_url="https://api.workos.com",
        jwks_uri=f"https://api.workos.com/sso/jwks/{client_id}",
        audience=client_id,
        algorithms=["RS256"],
        verify_iss=True,
    )
