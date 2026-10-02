"""Install Traefik v3.6.1+ (swarm provider) + Portainer CE with admin init."""
from __future__ import annotations

import logging
import secrets
import subprocess
from pathlib import Path

from . import checks, portainer_client

log = logging.getLogger("setupimpa.base")
ROOT = Path("/root")
DADOS = Path("/root/dados_vps")
NETWORK = __import__("os").environ.get("SETUPIMPA_NETWORK", "network_public")

TRAEFIK_YAML = """version: "3.7"
services:

## --------------------------- IMPA --------------------------- ##

  traefik:
    image: traefik:v3.6.1
    command:
      - "--api.dashboard=true"
      - "--providers.swarm=true"
      - "--providers.swarm.endpoint=unix:///var/run/docker.sock"
      - "--providers.swarm.exposedbydefault=false"
      - "--providers.swarm.network={network}"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entryPoint.to=websecure"
      - "--entrypoints.web.http.redirections.entryPoint.scheme=https"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencryptresolver.acme.httpchallenge=true"
      - "--certificatesresolvers.letsencryptresolver.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencryptresolver.acme.email={email}"
      - "--certificatesresolvers.letsencryptresolver.acme.storage=/etc/traefik/letsencrypt/acme.json"
      - "--log.level=INFO"

    volumes:
      - "vol_certificates:/etc/traefik/letsencrypt"
      - "/var/run/docker.sock:/var/run/docker.sock:ro"

    networks:
      - {network}

    environment:
      - DOCKER_API_VERSION=1.45

    ports:
      - target: 80
        published: 80
        mode: host
      - target: 443
        published: 443
        mode: host

    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      labels:
        - "traefik.enable=true"

## --------------------------- IMPA --------------------------- ##

volumes:
  vol_certificates:
    external: true
    name: volume_swarm_certificates

networks:
  {network}:
    external: true
    name: {network}
"""

PORTAINER_YAML = """version: "3.7"
services:

## --------------------------- IMPA --------------------------- ##

  agent:
    image: portainer/agent:2.27.1

    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes

    networks:
      - {network}

    deploy:
      mode: global
      placement:
        constraints:
          - node.platform.os == linux

## --------------------------- IMPA --------------------------- ##

  portainer:
    image: portainer/portainer-ce:2.27.1
    command: -H tcp://tasks.agent:9001 --tlsskipverify

    volumes:
      - portainer_data:/data

    networks:
      - {network}

    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.portainer.rule=Host(`{domain}`)"
        - "traefik.http.routers.portainer.entrypoints=websecure"
        - "traefik.http.routers.portainer.tls.certresolver=letsencryptresolver"
        - "traefik.http.routers.portainer.service=portainer"
        - "traefik.http.services.portainer.loadbalancer.server.port=9000"
        - "traefik.http.services.portainer.loadbalancer.passHostHeader=true"

## --------------------------- IMPA --------------------------- ##

volumes:
  portainer_data:
    external: true
    name: portainer_data

networks:
  {network}:
    external: true
    name: {network}
"""


def _run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=check, text=True, capture_output=True)


def ensure_network() -> None:
    out = _run(["docker", "network", "ls", "--format", "{{.Name}}"], check=False)
    names = {l.strip() for l in (out.stdout or "").splitlines()}
    if NETWORK not in names:
        _run(["docker", "network", "create", "--driver", "overlay", "--attachable", NETWORK])


def ensure_volumes() -> None:
    for vol in ("volume_swarm_certificates", "portainer_data"):
        _run(["docker", "volume", "create", vol], check=False)


def install_base(*, email: str, portainer_domain: str, user: str, password: str) -> dict:
    portainer_domain = checks.normalize_domain(portainer_domain)
    if not checks.validate_domain_name(portainer_domain):
        return {"ok": False, "error": "dominio_invalido"}
    if not email or "@" not in email:
        return {"ok": False, "error": "email_invalido"}
    if not user:
        user = "admin"
    if not password or len(password) < 8:
        password = secrets.token_urlsafe(12)

    ensure_network()
    ensure_volumes()
    DADOS.mkdir(parents=True, exist_ok=True)

    traefik = TRAEFIK_YAML.format(network=NETWORK, email=email)
    portainer = PORTAINER_YAML.format(network=NETWORK, domain=portainer_domain)

    (ROOT / "traefik.yaml").write_text(traefik, encoding="utf-8")
    (ROOT / "portainer.yaml").write_text(portainer, encoding="utf-8")

    r1 = _run(["docker", "stack", "deploy", "--prune", "--resolve-image", "always", "-c", "/root/traefik.yaml", "traefik"], check=False)
    if r1.returncode != 0:
        return {"ok": False, "error": "traefik_deploy", "detail": (r1.stderr or r1.stdout)[:500]}

    r2 = _run(["docker", "stack", "deploy", "--prune", "--resolve-image", "always", "-c", "/root/portainer.yaml", "portainer"], check=False)
    if r2.returncode != 0:
        return {"ok": False, "error": "portainer_deploy", "detail": (r2.stderr or r2.stdout)[:500]}

    portainer_client.save_dados_portainer(portainer_domain, user, password)

    return {
        "ok": True,
        "traefik": True,
        "portainer": True,
        "domain": portainer_domain,
        "user": user,
        "password": password,
        "email": email,
        "next": "dns_gate",
        "message": f"Aponte o A record de {portainer_domain} para {checks.public_ip()} e valide o DNS.",
    }


def finish_base_after_dns(*, confirm_cloudflare: bool = False) -> dict:
    dados = portainer_client._read_dados()
    domain = dados.get("domain", "")
    user = dados.get("user", "admin")
    password = dados.get("pass", "")
    if not domain:
        return {"ok": False, "error": "dados_portainer_ausente"}

    dns = checks.check_dns(domain)
    if not dns.get("match") and not (dns.get("cloudflare") and confirm_cloudflare):
        return {"ok": False, "error": "dns_pending", "dns": dns}

    init = portainer_client.init_admin(user, password, domain)
    if not init.get("ok"):
        return {"ok": False, "error": "admin_init_failed", "detail": init, "dns": dns}

    auth = portainer_client.login(user, password, domain)
    return {
        "ok": bool(auth.get("ok")),
        "dns": dns,
        "admin": init,
        "auth": {"ok": auth.get("ok"), "user": user, "domain": domain},
        "credentials": {
            "url": f"https://{domain}",
            "user": user,
            "password": password,
        },
    }
