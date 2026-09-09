"""Configuration validation utilities for checking required API keys."""

import os
import re
from typing import Any

# Host of the removed NVIDIA NIM endpoint. Any llm entry still pointing here,
# or still typed `nim`, is a stale config — not a working provider.
NIM_API_HOST = "integrate.api.nvidia.com"

# Surfaced whenever NIM remnants are found: names the supported config so the
# failure is actionable at startup instead of a deep client error later.
NIM_UNSUPPORTED_MESSAGE = "nim configs no longer supported; migrate to config_oib_openrouter.yml"

# Mapping of LLM _type to required API key environment variable names
# This can be extended as new providers are added
LLM_API_KEY_MAP = {
    "openai": ["OPENAI_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
    "google": ["GOOGLE_API_KEY"],
    "gemini": ["GOOGLE_API_KEY"],
    # Add more providers as needed
}


def _extract_env_var(value: str) -> str | None:
    """Extract environment variable name from ${VAR_NAME} syntax."""
    if isinstance(value, str):
        match = re.match(r"\$\{([^}]+)\}", value)
        if match:
            return match.group(1)
    return None


def _get_llm_api_key_requirements(llm_config: dict[str, Any]) -> list[str]:
    """
    Determine required API keys for an LLM configuration.

    Args:
        llm_config: LLM configuration dictionary with _type and optional api_key

    Returns:
        List of required API key environment variable names
    """
    llm_type = llm_config.get("_type", "").lower()
    required_keys = LLM_API_KEY_MAP.get(llm_type, [])

    # If api_key is explicitly set in config, check if it references an env var
    api_key_config = llm_config.get("api_key")
    if api_key_config:
        env_var = _extract_env_var(api_key_config)
        if env_var:
            # If config specifies an env var, that's the required key
            return [env_var]
        # If api_key is a literal value, no env var needed
        return []

    return required_keys


def find_nim_llms(config: dict[str, Any]) -> list[str]:
    """
    Names of ``llms`` entries still pointing at the removed NVIDIA NIM provider.

    An entry qualifies by its ``_type`` (``nim``) or by its ``base_url`` host
    (``integrate.api.nvidia.com``) — either is a stale config, and since the
    ``nim`` key mapping was dropped such an entry would otherwise validate
    silently and fail later inside a client call.
    """
    offenders = []
    llms_config = config.get("llms", {}) or {}
    for llm_name, llm_config in llms_config.items():
        if not isinstance(llm_config, dict):
            continue
        llm_type = str(llm_config.get("_type", "")).lower()
        base_url = str(llm_config.get("base_url", "")).lower()
        if llm_type == "nim" or (base_url and NIM_API_HOST in base_url):
            offenders.append(llm_name)
    return offenders


def assert_no_nim_llms(config: dict[str, Any]) -> None:
    """
    Fail fast on NIM remnants — raise, never let them reach a client.

    Raises:
        ValueError: With a message naming the supported config, when any
            ``llms`` entry still uses ``_type: nim`` or the NVIDIA endpoint.
    """
    offenders = find_nim_llms(config)
    if offenders:
        raise ValueError(f"{NIM_UNSUPPORTED_MESSAGE} (offending llm entries: {', '.join(offenders)})")


def validate_llm_configs(config: dict[str, Any]) -> tuple[bool, list[str]]:
    """
    Validate that all required API keys are set for LLMs in the configuration.

    Args:
        config: Full workflow configuration dictionary

    Returns:
        Tuple of (is_valid, missing_keys) where:
        - is_valid: True if all required keys are present
        - missing_keys: List of missing API key names

    Raises:
        ValueError: When any ``llms`` entry still uses the removed NIM
            provider (see :func:`assert_no_nim_llms`) — a stale config must
            fail here, not later inside a client call.
    """
    assert_no_nim_llms(config)
    llms_config = config.get("llms", {})
    if not llms_config:
        return True, []

    missing_keys = []
    checked_keys = set()  # Track which keys we've already checked

    for llm_name, llm_config in llms_config.items():
        if not isinstance(llm_config, dict):
            continue

        required_keys = _get_llm_api_key_requirements(llm_config)

        for key in required_keys:
            if key not in checked_keys:
                checked_keys.add(key)
                if not os.getenv(key):
                    missing_keys.append(key)

    return len(missing_keys) == 0, missing_keys


def get_llm_provider_info(llm_config: dict[str, Any]) -> str:
    """
    Get human-readable information about an LLM provider.

    Args:
        llm_config: LLM configuration dictionary

    Returns:
        Provider name and API key source information
    """
    llm_type = llm_config.get("_type", "unknown")
    api_key_config = llm_config.get("api_key")

    if api_key_config:
        env_var = _extract_env_var(api_key_config)
        if env_var:
            return f"{llm_type} (requires {env_var})"
        return f"{llm_type} (api_key set in config)"

    required_keys = LLM_API_KEY_MAP.get(llm_type.lower(), [])
    if required_keys:
        return f"{llm_type} (requires {', '.join(required_keys)})"

    return f"{llm_type} (no API key required)"
