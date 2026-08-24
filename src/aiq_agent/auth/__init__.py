"""Shared authentication utilities for AI-Q blueprint.

This module provides token retrieval and user info utilities that can be used
by any tool or agent.
"""

from .utils import Principal
from .utils import UserInfo
from .utils import clear_token_fetchers
from .utils import decode_unverified_jwt_payload
from .utils import get_auth_token
from .utils import get_current_principal
from .utils import get_current_user_info
from .utils import get_user_info_from_unverified_token
from .utils import get_verified_current_user
from .utils import register_token_fetcher
from .utils import unregister_token_fetcher

__all__ = [
    "Principal",
    "UserInfo",
    "clear_token_fetchers",
    "decode_unverified_jwt_payload",
    "get_auth_token",
    "get_current_principal",
    "get_current_user_info",
    "get_user_info_from_unverified_token",
    "get_verified_current_user",
    "register_token_fetcher",
    "unregister_token_fetcher",
]
