"""SetupImpa preflight / DNS / domain checks — ported from IMPA Migrator."""
from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

CLOUDFLARE_PREFIXES = (
    "104.", "172.67.", "173.245.", "141.101.", "108.162.",
    "190.93.", "188.114.", "197.234.", "198.41.", "162.158.",
    "103.21.", "103.22.", "103.31.",
)

UBUNTU_OK = {"20.04", "22.04", "23.04", "23.10", "24.04", "24.10", "25.04"}
DEBIAN_OK = {"11", "12", "13"}


def _read_os_release() -> dict[str, str]:
    data: dict[str, str] = {}
    path = Path("/etc/os-release")
    if not path.exists():
        return data
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            data[k] = v.strip().strip('"')
    return data


def public_ip() -> str:
    env = os.environ.get("SETUPIMPA_PUBLIC_IP", "").strip()
    if env:
        return env
    for cmd in (
        ["curl", "-s4", "--max-time", "4", "ifconfig.me"],
        ["curl", "-s4", "--max-time", "4", "icanhazip.com"],
    ):
        try:
            out = subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL).strip()
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", out):
                return out
        except Exception:
            continue
    try:
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return ""


def active_network() -> str:
    """Retorna a rede interna ativa, detectando automaticamente se há SetupOrion na VPS."""
    dados_vps = Path("/root/dados_vps/dados_vps")
    if dados_vps.exists():
        try:
            for line in dados_vps.read_text(encoding="utf-8", errors="replace").splitlines():
                if "Rede interna:" in line:
                    net = line.split("Rede interna:", 1)[1].strip()
                    if net:
                        return net
        except Exception:
            pass
    return os.environ.get("SETUPIMPA_NETWORK", "").strip() or "network_public"


def validate_domain_name(domain: str) -> bool:
    if not domain or len(domain) > 253:
        return False
    domain = domain.strip().lower()
    if domain.startswith("http://") or domain.startswith("https://"):
        return False
    return bool(re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$", domain))


def normalize_domain(domain: str) -> str:
    d = (domain or "").strip().lower()
    d = re.sub(r"^https?://", "", d)
    return d.strip("/")


def is_cloudflare_ip(ip: str) -> bool:
    return any(ip.startswith(p) for p in CLOUDFLARE_PREFIXES)


def resolve_domain_a(domain: str) -> str:
    domain = normalize_domain(domain)
    # Prefer public resolvers (avoid stale systemd-resolved cache)
    for dns in ("1.1.1.1", "8.8.8.8"):
        try:
            out = subprocess.check_output(
                ["dig", f"@{dns}", "+time=2", "+tries=1", "+short", "A", domain],
                text=True,
                stderr=subprocess.DEVNULL,
            )
            for line in out.splitlines():
                line = line.strip()
                if re.match(r"^\d+\.\d+\.\d+\.\d+$", line):
                    return line
        except Exception:
            continue
    try:
        return socket.gethostbyname(domain)
    except Exception:
        return ""


def traefik_host_health(domain: str) -> dict[str, Any]:
    domain = normalize_domain(domain)
    try:
        out = subprocess.check_output(
            [
                "curl", "-sk", "-o", "/dev/null", "-w", "%{http_code}",
                "-H", f"Host: {domain}",
                "--max-time", "8",
                "https://127.0.0.1/",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        code = int(out) if out.isdigit() else 0
    except Exception:
        code = 0
    ok_codes = {200, 301, 302, 307, 308, 401, 404, 503}
    return {"http_code": code, "ok": code in ok_codes}


def disk_free_bytes(path: str = "/") -> int:
    usage = shutil.disk_usage(path)
    return int(usage.free)


def docker_installed() -> bool:
    # O agent roda dentro de um container com /var/run/docker.sock montado
    sock = Path("/var/run/docker.sock")
    if sock.exists():
        try:
            import docker
            client = docker.DockerClient(base_url="unix://var/run/docker.sock")
            client.ping()
            return True
        except Exception:
            pass
    return shutil.which("docker") is not None


def swarm_active() -> bool:
    sock = Path("/var/run/docker.sock")
    if sock.exists():
        try:
            import docker
            client = docker.DockerClient(base_url="unix://var/run/docker.sock")
            info = client.info()
            return info.get("Swarm", {}).get("LocalNodeState", "").lower() == "active"
        except Exception:
            pass
    if not docker_installed():
        return False
    try:
        out = subprocess.check_output(["docker", "info", "--format", "{{.Swarm.LocalNodeState}}"], text=True)
        return out.strip().lower() == "active"
    except Exception:
        return False


def stack_exists(name: str) -> bool:
    sock = Path("/var/run/docker.sock")
    if sock.exists():
        try:
            import docker
            client = docker.DockerClient(base_url="unix://var/run/docker.sock")
            services = client.services.list(filters={"label": f"com.docker.stack.namespace={name}"})
            if len(services) > 0:
                return True
        except Exception:
            pass
    try:
        out = subprocess.check_output(["docker", "stack", "ls", "--format", "{{.Name}}"], text=True)
        return name in {l.strip() for l in out.splitlines() if l.strip()}
    except Exception:
        return False


def run_preflight(min_free_gb: float = 5.0) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    osr = _read_os_release()
    os_id = osr.get("ID", "")
    os_ver = osr.get("VERSION_ID", "")
    arch = platform.machine()

    # root
    is_root = os.geteuid() == 0 if hasattr(os, "geteuid") else True
    checks.append({
        "id": "root",
        "label": "Executando como root",
        "ok": is_root,
        "detail": "root" if is_root else "nao-root",
    })

    # OS
    os_ok = (os_id == "debian" and os_ver in DEBIAN_OK) or (os_id == "ubuntu" and os_ver in UBUNTU_OK)
    checks.append({
        "id": "os",
        "label": "SO homologado (Debian 11–13 / Ubuntu 20.04+)",
        "ok": os_ok,
        "detail": f"{os_id} {os_ver}" if os_id else "desconhecido",
    })

    checks.append({
        "id": "arch",
        "label": "Arquitetura",
        "ok": True,
        "detail": arch,
    })

    free = disk_free_bytes("/")
    need = int(min_free_gb * 1024**3)
    checks.append({
        "id": "disk",
        "label": f"Espaco em disco (>= {min_free_gb}GB)",
        "ok": free >= need,
        "detail": f"livre={free} necessario={need}",
    })

    has_docker = docker_installed()
    swarm = swarm_active()
    checks.append({
        "id": "docker",
        "label": "Docker instalado",
        "ok": has_docker,
        "detail": "sim" if has_docker else "nao",
    })
    checks.append({
        "id": "swarm",
        "label": "Docker Swarm ativo",
        "ok": swarm,
        "detail": "active" if swarm else "inactive",
    })

    greenfield = not has_docker
    checks.append({
        "id": "greenfield",
        "label": "VPS limpa (sem Docker) — informativo",
        "ok": True,
        "detail": "limpa" if greenfield else "docker_ja_existe",
        "warn": not greenfield,
    })

    base_ready = stack_exists("traefik") and stack_exists("portainer")
    checks.append({
        "id": "base",
        "label": "Infra base (Traefik + Portainer)",
        "ok": base_ready,
        "detail": "instalada" if base_ready else "pendente",
    })

    all_hard_ok = all(c["ok"] for c in checks if c["id"] not in ("greenfield", "base"))
    return {
        "ok": all_hard_ok,
        "public_ip": public_ip(),
        "checks": checks,
        "base_installed": base_ready,
        "accepted_risk": Path("/root/dados_vps/setupimpa_accepted").exists(),
    }


def check_dns(domain: str, expect_ip: str | None = None) -> dict[str, Any]:
    domain = normalize_domain(domain)
    if not validate_domain_name(domain):
        return {
            "ok": False,
            "domain": domain,
            "error": "dominio_invalido",
            "resolved": "",
            "expected": expect_ip or public_ip(),
            "cloudflare": False,
            "match": False,
        }
    expected = expect_ip or public_ip()
    resolved = resolve_domain_a(domain)
    cf = bool(resolved) and is_cloudflare_ip(resolved)
    match = bool(resolved) and resolved == expected
    health = traefik_host_health(domain) if match or cf else {"http_code": 0, "ok": False}
    return {
        "ok": match or cf,
        "domain": domain,
        "resolved": resolved,
        "expected": expected,
        "cloudflare": cf,
        "match": match,
        "traefik_health": health,
        "needs_manual_confirm": cf and not match,
    }
