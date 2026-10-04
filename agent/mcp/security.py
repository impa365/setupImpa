"""SetupImpa MCP Security — IP Whitelist enforcement and Cloudflare WAF integration."""
from __future__ import annotations

import ipaddress
import json
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import Request

log = logging.getLogger("setupimpa.mcp.security")

DADOS = Path("/root/dados_vps")
MCP_SECURITY_FILE = DADOS / "mcp_security.json"


def load_security_config() -> dict[str, Any]:
    """Load persistent MCP security configuration."""
    DADOS.mkdir(parents=True, exist_ok=True)
    if MCP_SECURITY_FILE.exists():
        try:
            data = json.loads(MCP_SECURITY_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {
                    "ip_whitelist_enabled": bool(data.get("ip_whitelist_enabled", False)),
                    "allowed_ips": list(data.get("allowed_ips", [])),
                    "cloudflare_waf_enabled": bool(data.get("cloudflare_waf_enabled", False)),
                    "last_updated": data.get("last_updated", 0),
                }
        except Exception as e:
            log.warning("Failed to parse mcp_security.json: %s", e)

    return {
        "ip_whitelist_enabled": False,
        "allowed_ips": [],
        "cloudflare_waf_enabled": False,
        "last_updated": 0,
    }


def save_security_config(config: dict[str, Any]) -> dict[str, Any]:
    """Persist MCP security settings."""
    DADOS.mkdir(parents=True, exist_ok=True)
    clean_ips: list[str] = []
    for item in config.get("allowed_ips", []):
        item_str = str(item).strip()
        if not item_str:
            continue
        try:
            if "/" in item_str:
                ipaddress.ip_network(item_str, strict=False)
            else:
                ipaddress.ip_address(item_str)
            clean_ips.append(item_str)
        except ValueError:
            log.warning("Ignoring invalid IP or CIDR in whitelist: %s", item_str)

    data = {
        "ip_whitelist_enabled": bool(config.get("ip_whitelist_enabled", False)),
        "allowed_ips": clean_ips,
        "cloudflare_waf_enabled": bool(config.get("cloudflare_waf_enabled", False)),
        "last_updated": int(time.time()),
    }
    MCP_SECURITY_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        MCP_SECURITY_FILE.chmod(0o600)
    except Exception:
        pass
    return data


def get_client_ip(request: Request) -> str:
    """Extract real client IP from Cloudflare, reverse proxies (Traefik) or socket."""
    # 1. Cloudflare connecting IP
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip and cf_ip.strip():
        return cf_ip.strip()

    # 2. Standard X-Forwarded-For (client is leftmost)
    xff = request.headers.get("x-forwarded-for")
    if xff and xff.strip():
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[0]

    # 3. X-Real-IP
    x_real = request.headers.get("x-real-ip")
    if x_real and x_real.strip():
        return x_real.strip()

    # 4. Fallback socket host
    if request.client and request.client.host:
        return request.client.host.strip()

    return "127.0.0.1"


def is_ip_allowed(client_ip: str, allowed_ips: list[str]) -> bool:
    """Check if client IP matches allowed list (exact IP or CIDR)."""
    if not allowed_ips:
        return True

    try:
        client_addr = ipaddress.ip_address(client_ip)
    except ValueError:
        return False

    # Always permit localhost/loopback
    if client_addr.is_loopback:
        return True

    for entry in allowed_ips:
        clean_entry = entry.strip()
        if not clean_entry:
            continue
        try:
            if "/" in clean_entry:
                net = ipaddress.ip_network(clean_entry, strict=False)
                if client_addr in net:
                    return True
            else:
                addr = ipaddress.ip_address(clean_entry)
                if client_addr == addr:
                    return True
        except ValueError:
            continue

    return False


def sync_cloudflare_ip_rule(ip_or_cidr: str, mode: str = "whitelist", notes: str = "SetupImpa MCP Access") -> dict[str, Any]:
    """Push an IP access rule to Cloudflare zone for edge defense."""
    try:
        from installer import cloudflare, panel_domain
        token = cloudflare.get_token()
        if not token:
            return {"ok": False, "error": "Token da Cloudflare não configurado na VPS."}

        dom_info = panel_domain.get_panel_domain_info()
        domain = dom_info.get("domain")
        if not domain:
            return {"ok": False, "error": "Domínio do painel ainda não configurado para localizar a Zona na Cloudflare."}

        zone_res = cloudflare.find_zone(domain, token)
        if not zone_res.get("ok"):
            return {"ok": False, "error": f"Não foi possível localizar a zona Cloudflare para {domain}."}

        zone_id = zone_res["zone_id"]
        target = "ip_range" if "/" in ip_or_cidr else "ip"

        body = {
            "mode": mode,
            "configuration": {
                "target": target,
                "value": ip_or_cidr.strip(),
            },
            "notes": notes,
        }

        res = cloudflare._cf_request("POST", f"/zones/{zone_id}/firewall/access_rules/rules", token, body)
        if res.get("success"):
            return {"ok": True, "result": res.get("result"), "message": f"Regra de IP ({ip_or_cidr}) criada com sucesso no Firewall Cloudflare!"}
        
        errors = res.get("errors", [])
        err_msg = errors[0].get("message", "Falha ao criar regra no Cloudflare") if errors else "Erro desconhecido"
        return {"ok": False, "error": err_msg}
    except Exception as e:
        return {"ok": False, "error": str(e)}
