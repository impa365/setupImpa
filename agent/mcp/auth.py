"""SetupImpa MCP Authentication — dedicated persistent API Key & session fallback."""
from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any

from installer import auth

DADOS = Path("/root/dados_vps")
MCP_KEY_FILE = DADOS / "setupimpa_mcp_key.json"


def get_or_create_mcp_key() -> str:
    """Return persistent MCP API key, generating one securely if missing."""
    DADOS.mkdir(parents=True, exist_ok=True)
    if MCP_KEY_FILE.exists():
        try:
            data = json.loads(MCP_KEY_FILE.read_text(encoding="utf-8"))
            key = data.get("api_key")
            if key and len(key) >= 24:
                return key
        except Exception:
            pass

    # Generate new high-entropy token
    new_key = f"impa_mcp_{secrets.token_urlsafe(32)}"
    payload = {
        "api_key": new_key,
        "created_at": int(time.time()),
        "description": "SetupImpa Official MCP API Key",
    }
    MCP_KEY_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        MCP_KEY_FILE.chmod(0o600)
    except Exception:
        pass
    return new_key


def regenerate_mcp_key() -> str:
    """Regenerate and save a fresh MCP API key."""
    DADOS.mkdir(parents=True, exist_ok=True)
    new_key = f"impa_mcp_{secrets.token_urlsafe(32)}"
    payload = {
        "api_key": new_key,
        "created_at": int(time.time()),
        "description": "SetupImpa Official MCP API Key",
    }
    MCP_KEY_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        MCP_KEY_FILE.chmod(0o600)
    except Exception:
        pass
    return new_key


def validate_mcp_token(token: str | None) -> dict[str, Any] | None:
    """Validate bearer token against persistent MCP key OR panel session token OR root env token."""
    if not token:
        return None
    token = token.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    # 1. Check persistent MCP API key
    current_key = get_or_create_mcp_key()
    if secrets.compare_digest(token, current_key):
        return {"authenticated": True, "auth_type": "mcp_key", "user": "mcp_agent"}

    # 2. Check admin session fallback
    session = auth.validate_session(token)
    if session:
        return {"authenticated": True, "auth_type": "admin_session", "user": session.get("username", "admin")}

    # 3. Check root deployment token
    import os
    env_token = os.environ.get("SETUPIMPA_TOKEN", "").strip()
    if env_token and secrets.compare_digest(token, env_token):
        return {"authenticated": True, "auth_type": "env_token", "user": "root"}

    return None
