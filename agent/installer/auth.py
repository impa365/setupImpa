"""SetupImpa panel auth — first-access admin setup + session login."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path
from typing import Any

DADOS = Path("/root/dados_vps")
ADMIN_FILE = DADOS / "setupimpa_admin.json"
SESSIONS_FILE = DADOS / "setupimpa_sessions.json"

PBKDF2_ITER = 120_000


def _ensure_dir() -> None:
    DADOS.mkdir(parents=True, exist_ok=True)


def setup_required() -> bool:
    if not ADMIN_FILE.exists():
        return True
    try:
        data = json.loads(ADMIN_FILE.read_text(encoding="utf-8"))
        return not bool(data.get("username") and data.get("password_hash"))
    except Exception:
        return True


def _hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER)
    return salt.hex(), digest.hex()


def _verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    try:
        salt = bytes.fromhex(salt_hex)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER)
        return hmac.compare_digest(digest.hex(), hash_hex)
    except Exception:
        return False


def create_admin(username: str, password: str) -> dict[str, Any]:
    username = (username or "").strip()
    if setup_required() is False:
        return {"ok": False, "error": "ja_configurado"}
    if len(username) < 3:
        return {"ok": False, "error": "usuario_curto"}
    if len(password) < 8:
        return {"ok": False, "error": "senha_curta"}
    _ensure_dir()
    salt, pw_hash = _hash_password(password)
    payload = {
        "username": username,
        "salt": salt,
        "password_hash": pw_hash,
        "created_at": int(time.time()),
    }
    ADMIN_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        ADMIN_FILE.chmod(0o600)
    except Exception:
        pass
    return {"ok": True, "username": username}


def _load_sessions() -> dict[str, Any]:
    if not SESSIONS_FILE.exists():
        return {}
    try:
        return json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_sessions(data: dict[str, Any]) -> None:
    _ensure_dir()
    SESSIONS_FILE.write_text(json.dumps(data), encoding="utf-8")
    try:
        SESSIONS_FILE.chmod(0o600)
    except Exception:
        pass


def login(username: str, password: str) -> dict[str, Any]:
    if setup_required():
        return {"ok": False, "error": "setup_required"}
    admin = json.loads(ADMIN_FILE.read_text(encoding="utf-8"))
    if username.strip() != admin.get("username"):
        return {"ok": False, "error": "credenciais_invalidas"}
    if not _verify_password(password, admin["salt"], admin["password_hash"]):
        return {"ok": False, "error": "credenciais_invalidas"}

    token = secrets.token_urlsafe(32)
    sessions = _load_sessions()
    # prune expired (>7 days)
    now = int(time.time())
    sessions = {k: v for k, v in sessions.items() if now - int(v.get("ts", 0)) < 7 * 86400}
    sessions[token] = {"user": admin["username"], "ts": now}
    _save_sessions(sessions)
    return {"ok": True, "token": token, "username": admin["username"]}


def logout(token: str) -> None:
    if not token:
        return
    sessions = _load_sessions()
    if token in sessions:
        del sessions[token]
        _save_sessions(sessions)


def validate_session(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    sessions = _load_sessions()
    entry = sessions.get(token)
    if not entry:
        return None
    if int(time.time()) - int(entry.get("ts", 0)) > 7 * 86400:
        del sessions[token]
        _save_sessions(sessions)
        return None
    return {"username": entry.get("user")}


def status(token: str | None = None) -> dict[str, Any]:
    sess = validate_session(token or "")
    return {
        "setup_required": setup_required(),
        "authenticated": bool(sess),
        "username": (sess or {}).get("username"),
    }
