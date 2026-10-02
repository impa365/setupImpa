"""SetupImpa — Cloudflare DNS automation via API.

Required Cloudflare API Token scopes:
  - Zone:DNS:Edit
  - Zone:Zone:Read
"""
from __future__ import annotations

import json
import logging
import os
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any

log = logging.getLogger("setupimpa.cloudflare")

CF_API = "https://api.cloudflare.com/client/v4"
DADOS = Path("/root/dados_vps")
CF_TOKEN_FILE = DADOS / "cloudflare_token"


# ── Token persistence ──────────────────────────────────────────────

def _saved_token() -> str:
    if CF_TOKEN_FILE.exists():
        return CF_TOKEN_FILE.read_text(encoding="utf-8").strip()
    return os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()


def save_token(token: str) -> None:
    DADOS.mkdir(parents=True, exist_ok=True)
    CF_TOKEN_FILE.write_text(token.strip() + "\n", encoding="utf-8")
    CF_TOKEN_FILE.chmod(0o600)
    log.info("Cloudflare token saved")


def get_token() -> str:
    return _saved_token()


def has_token() -> bool:
    return bool(_saved_token())


# ── HTTP helpers ───────────────────────────────────────────────────

def _cf_request(method: str, path: str, token: str, body: dict | None = None) -> dict:
    """Low-level Cloudflare API request."""
    url = f"{CF_API}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read())
        except Exception:
            err_body = {"errors": [{"message": str(e)}]}
        return {"success": False, "errors": err_body.get("errors", [{"message": str(e)}])}
    except Exception as e:
        return {"success": False, "errors": [{"message": str(e)}]}


# ── Token validation ──────────────────────────────────────────────

def verify_token(token: str) -> dict[str, Any]:
    """Validate a Cloudflare API token and return scope info."""
    result = _cf_request("GET", "/user/tokens/verify", token)
    if result.get("success") and result.get("result", {}).get("status") == "active":
        return {"ok": True, "status": "active"}
    errors = result.get("errors", [])
    msg = errors[0].get("message", "token_invalido") if errors else "token_invalido"
    return {"ok": False, "error": msg}


# ── Zone lookup ───────────────────────────────────────────────────

def _extract_root_domain(domain: str) -> list[str]:
    """Return candidate root domains for zone lookup.
    e.g. 'evo.clientes.impa365.com' → ['impa365.com', 'clientes.impa365.com', ...]
    """
    parts = domain.strip(".").split(".")
    candidates = []
    for i in range(len(parts) - 1):
        candidates.append(".".join(parts[i:]))
    return candidates


def find_zone(domain: str, token: str) -> dict[str, Any]:
    """Find the Cloudflare zone_id for a domain."""
    for candidate in _extract_root_domain(domain):
        result = _cf_request("GET", f"/zones?name={candidate}&status=active", token)
        if result.get("success") and result.get("result"):
            zone = result["result"][0]
            return {
                "ok": True,
                "zone_id": zone["id"],
                "zone_name": zone["name"],
                "status": zone.get("status", "active"),
            }
    return {"ok": False, "error": f"zona_nao_encontrada para {domain}"}


# ── DNS record management ─────────────────────────────────────────

def list_dns_records(zone_id: str, token: str, name: str = "", type_: str = "") -> list[dict]:
    """List DNS records for a zone, optionally filtered."""
    params = []
    if name:
        params.append(f"name={name}")
    if type_:
        params.append(f"type={type_}")
    qs = "&".join(params)
    path = f"/zones/{zone_id}/dns_records"
    if qs:
        path += f"?{qs}"
    result = _cf_request("GET", path, token)
    if result.get("success"):
        return result.get("result", [])
    return []


def create_or_update_dns(
    domain: str,
    ip: str,
    token: str,
    *,
    type_: str = "A",
    proxied: bool = False,
    ttl: int = 1,  # 1 = automatic
) -> dict[str, Any]:
    """Create or update a DNS record. Main entry point for SetupImpa."""
    domain = domain.strip().lower()

    # Find zone
    zone = find_zone(domain, token)
    if not zone.get("ok"):
        return zone

    zone_id = zone["zone_id"]

    # Check if record already exists
    existing = list_dns_records(zone_id, token, name=domain, type_=type_)

    record_data = {
        "type": type_,
        "name": domain,
        "content": ip,
        "ttl": ttl,
        "proxied": proxied,
    }

    if existing:
        # Update existing record
        record_id = existing[0]["id"]
        old_ip = existing[0].get("content", "")
        result = _cf_request("PUT", f"/zones/{zone_id}/dns_records/{record_id}", token, body=record_data)
        if result.get("success"):
            log.info("DNS updated: %s → %s (was %s)", domain, ip, old_ip)
            return {
                "ok": True,
                "action": "updated",
                "domain": domain,
                "ip": ip,
                "old_ip": old_ip,
                "proxied": proxied,
                "record_id": record_id,
                "zone": zone["zone_name"],
            }
        errors = result.get("errors", [])
        msg = errors[0].get("message", "update_failed") if errors else "update_failed"
        return {"ok": False, "error": msg, "action": "update_failed"}
    else:
        # Create new record
        result = _cf_request("POST", f"/zones/{zone_id}/dns_records", token, body=record_data)
        if result.get("success"):
            record_id = result.get("result", {}).get("id", "")
            log.info("DNS created: %s → %s", domain, ip)
            return {
                "ok": True,
                "action": "created",
                "domain": domain,
                "ip": ip,
                "proxied": proxied,
                "record_id": record_id,
                "zone": zone["zone_name"],
            }
        errors = result.get("errors", [])
        msg = errors[0].get("message", "create_failed") if errors else "create_failed"
        return {"ok": False, "error": msg, "action": "create_failed"}


def delete_dns_record(domain: str, token: str, type_: str = "A") -> dict[str, Any]:
    """Delete a DNS record by domain name."""
    domain = domain.strip().lower()
    zone = find_zone(domain, token)
    if not zone.get("ok"):
        return zone

    zone_id = zone["zone_id"]
    existing = list_dns_records(zone_id, token, name=domain, type_=type_)
    if not existing:
        return {"ok": True, "action": "not_found", "domain": domain}

    record_id = existing[0]["id"]
    result = _cf_request("DELETE", f"/zones/{zone_id}/dns_records/{record_id}", token)
    if result.get("success"):
        log.info("DNS deleted: %s (type=%s)", domain, type_)
        return {"ok": True, "action": "deleted", "domain": domain, "record_id": record_id}
    errors = result.get("errors", [])
    msg = errors[0].get("message", "delete_failed") if errors else "delete_failed"
    return {"ok": False, "error": msg}


# ── Batch: create DNS for all domains of an install ────────────────

def ensure_dns_for_domain(domain: str, ip: str | None = None, proxied: bool = False) -> dict[str, Any]:
    """High-level: ensure domain → ip (auto-detect IP if None). Uses saved token."""
    token = get_token()
    if not token:
        return {"ok": False, "error": "cloudflare_token_nao_configurado"}

    if not ip:
        from . import checks
        ip = checks.public_ip()
    if not ip:
        return {"ok": False, "error": "ip_publico_nao_detectado"}

    return create_or_update_dns(domain, ip, token, proxied=proxied)
