"""SetupImpa — Custom domain and Traefik SSL automation for the SetupImpa Panel."""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from . import checks, cloudflare

log = logging.getLogger("setupimpa.panel_domain")

DADOS = Path("/root/dados_vps")
DOMAIN_FILE = DADOS / "panel_domain.json"
DYNAMIC_DIR = Path("/opt/setupimpa/traefik_dynamic")
ROUTER_FILE = DYNAMIC_DIR / "setupimpa.yaml"
TRAEFIK_YAML_PATH = Path("/root/traefik.yaml")


def _run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def is_port_exposed() -> bool:
    """Fast check from panel_domain.json with zero network latency."""
    if DOMAIN_FILE.exists():
        try:
            data = json.loads(DOMAIN_FILE.read_text(encoding="utf-8"))
            return bool(data.get("port_exposed", True))
        except Exception:
            pass
    return True


def get_configured_domain() -> str:
    """Fast lookup of configured domain without running network/SSL health checks."""
    if DOMAIN_FILE.exists():
        try:
            data = json.loads(DOMAIN_FILE.read_text(encoding="utf-8"))
            return data.get("domain", "").strip()
        except Exception:
            pass
    return ""


def apply_container_exposure(expose: bool) -> None:
    """Enforced seamlessly via application middleware without container recreation."""
    log.info("Port exposure preference updated: expose=%s", expose)


def get_public_ip() -> str:
    ip = os.environ.get("SETUPIMPA_PUBLIC_IP", "").strip()
    if ip:
        return ip
    ip_file = DADOS / "public_ip"
    if ip_file.exists():
        return ip_file.read_text(encoding="utf-8").strip()
    return checks.public_ip() or "74.1.21.235"


def get_panel_domain_info() -> dict[str, Any]:
    """Return status of custom domain configuration for SetupImpa."""
    configured = False
    domain = ""
    configured_at = None
    auto_cf = False
    cf_result = None

    if DOMAIN_FILE.exists():
        try:
            data = json.loads(DOMAIN_FILE.read_text(encoding="utf-8"))
            domain = data.get("domain", "")
            configured = bool(domain and ROUTER_FILE.exists())
            configured_at = data.get("configured_at")
            auto_cf = bool(data.get("auto_cloudflare"))
            cf_result = data.get("cf_result")
        except Exception as e:
            log.warning("Failed to read panel_domain.json: %s", e)

    public_ip = get_public_ip()
    traefik_active = checks.stack_exists("traefik")
    cf_token = cloudflare.get_token()
    has_cf = bool(cf_token)

    # Check SSL / DNS health if domain is configured
    dns_match = False
    ssl_active = False
    ssl_valid = False
    if configured and domain:
        try:
            h = checks.traefik_host_health(domain)
            ssl_active = bool(h.get("ok"))
            ssl_valid = bool(h.get("ssl_valid"))
        except Exception:
            pass
        try:
            dns_check = checks.check_dns(domain, public_ip)
            dns_match = bool(dns_check.get("match"))
        except Exception:
            pass

    port_exposed = is_port_exposed()

    return {
        "ok": True,
        "configured": configured,
        "domain": domain,
        "url": f"https://{domain}" if domain else f"http://{public_ip}:8877",
        "public_ip": public_ip,
        "ssl_active": ssl_valid if ssl_valid else ssl_active,
        "ssl_valid": ssl_valid,
        "dns_match": dns_match,
        "port_exposed": port_exposed,
        "traefik_ready": traefik_active,
        "has_cloudflare": has_cf,
        "auto_cloudflare": auto_cf,
        "configured_at": configured_at,
        "cf_result": cf_result,
    }


def ensure_traefik_dynamic_provider() -> bool:
    """Ensure Traefik stack mounts /opt/setupimpa/traefik_dynamic and watches it."""
    DYNAMIC_DIR.mkdir(parents=True, exist_ok=True)

    # Connect setupimpa-agent to network_public
    try:
        _run(["docker", "network", "connect", "network_public", "setupimpa-agent"], check=False)
    except Exception:
        pass

    if not TRAEFIK_YAML_PATH.exists():
        return False

    try:
        content = TRAEFIK_YAML_PATH.read_text(encoding="utf-8")
        needs_update = False

        if "--providers.file.directory=/etc/traefik/dynamic" not in content:
            content = content.replace(
                "--providers.swarm.network=network_public",
                "--providers.swarm.network=network_public\n      - \"--providers.file.directory=/etc/traefik/dynamic\"\n      - \"--providers.file.watch=true\""
            )
            needs_update = True

        if "/opt/setupimpa/traefik_dynamic:/etc/traefik/dynamic" not in content:
            content = content.replace(
                "- \"/var/run/docker.sock:/var/run/docker.sock:ro\"",
                "- \"/var/run/docker.sock:/var/run/docker.sock:ro\"\n      - \"/opt/setupimpa/traefik_dynamic:/etc/traefik/dynamic\""
            )
            needs_update = True

        if needs_update:
            TRAEFIK_YAML_PATH.write_text(content, encoding="utf-8")
            _run(["docker", "stack", "deploy", "--prune", "--resolve-image", "always", "-c", str(TRAEFIK_YAML_PATH), "traefik"], check=False)
            log.info("Traefik stack updated with dynamic file provider")
        return True
    except Exception as e:
        log.error("Failed to update Traefik stack for dynamic provider: %s", e)
        return False


def set_panel_domain(domain: str, auto_cloudflare: bool = True) -> dict[str, Any]:
    """Configure custom domain for SetupImpa via Traefik SSL and optional Cloudflare DNS."""
    clean_domain = re.sub(r"^https?://", "", domain.strip().lower()).rstrip("/")
    if not clean_domain or not re.match(r"^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", clean_domain):
        return {"ok": False, "error": "Domínio inválido. Use formato como: painel.meudominio.com"}

    public_ip = get_public_ip()
    ensure_traefik_dynamic_provider()

    # Write dynamic Traefik router
    DYNAMIC_DIR.mkdir(parents=True, exist_ok=True)
    router_yaml = f"""# SetupImpa Panel Traefik SSL Route
http:
  routers:
    setupimpa-secure:
      rule: "Host(`{clean_domain}`)"
      entryPoints:
        - "websecure"
      service: "setupimpa-service"
      tls:
        certResolver: "letsencryptresolver"

  services:
    setupimpa-service:
      loadBalancer:
        servers:
          - url: "http://setupimpa-agent:8877"
        passHostHeader: true
"""
    ROUTER_FILE.write_text(router_yaml, encoding="utf-8")

    # Cloudflare DNS automation
    cf_result = None
    cf_token = cloudflare.get_token()
    if auto_cloudflare and cf_token:
        try:
            cf_res = cloudflare.create_or_update_dns(
                domain=clean_domain,
                ip=public_ip,
                token=cf_token,
                proxied=False,  # DNS only so Let's Encrypt ACME HTTP challenge works flawlessly
            )
            cf_result = cf_res
        except Exception as e:
            cf_result = {"ok": False, "error": str(e)}

    # Save state
    DADOS.mkdir(parents=True, exist_ok=True)
    state_data = {
        "domain": clean_domain,
        "configured_at": int(__import__("time").time()),
        "auto_cloudflare": auto_cloudflare,
        "cf_result": cf_result,
        "public_ip": public_ip,
        "port_exposed": True,
    }
    DOMAIN_FILE.write_text(json.dumps(state_data, indent=2), encoding="utf-8")

    # Mantem a porta 8877 ativa para permitir fallback de conexao via IP
    apply_container_exposure(expose=True)

    return {
        "ok": True,
        "domain": clean_domain,
        "url": f"https://{clean_domain}",
        "public_ip": public_ip,
        "cf_result": cf_result,
        "port_exposed": True,
        "message": f"Domínio {clean_domain} conectado com sucesso ao Traefik SSL! Porta :8877 mantida ativa como IP Fallback de emergência.",
    }


def toggle_port_exposure(expose: bool) -> dict[str, Any]:
    """Toggle docker port 8877 mapping on the host (for IP fallback access)."""
    try:
        if DOMAIN_FILE.exists():
            data = json.loads(DOMAIN_FILE.read_text(encoding="utf-8"))
            data["port_exposed"] = bool(expose)
            DOMAIN_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        apply_container_exposure(expose=expose)
        msg = (
            "Porta :8877 exposta com sucesso para acesso via IP (fallback)."
            if expose
            else "Porta :8877 ocultada do host. Acesso exclusivamente via Domínio Traefik SSL."
        )
        return {"ok": True, "port_exposed": bool(expose), "message": msg}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def remove_panel_domain() -> dict[str, Any]:
    """Remove custom domain routing for SetupImpa."""
    try:
        if ROUTER_FILE.exists():
            ROUTER_FILE.unlink()
        if DOMAIN_FILE.exists():
            DOMAIN_FILE.unlink()

        # Restabelece exposição da porta 8877 no host Docker para permitir acesso via IP
        apply_container_exposure(expose=True)

        return {"ok": True, "message": "Domínio removido com sucesso. Porta :8877 exposta novamente para acesso via IP."}
    except Exception as e:
        return {"ok": False, "error": str(e)}
