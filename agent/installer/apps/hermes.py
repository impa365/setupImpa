"""Hermes Agent gateway + dashboard installer — multi-instance aware."""
from __future__ import annotations

import secrets
import subprocess
from pathlib import Path

from .. import checks, portainer_client, registry, validate

NETWORK = __import__("os").environ.get("SETUPIMPA_NETWORK", "network_public")

TEMPLATE = """version: "3.8"

services:

## --------------------------- HERMES (gateway + dashboard) --------------------------- ##

  hermes:
    image: nousresearch/hermes-agent:latest
    command: ["gateway", "run"]

    volumes:
      - {vol_data}:/opt/data

    networks:
      - {network}

    environment:
      - HERMES_UID=1000
      - HERMES_GID=1000
      - HERMES_DASHBOARD=1
      - HERMES_DASHBOARD_HOST=0.0.0.0
      - HERMES_DASHBOARD_PORT=9119
      - HERMES_DASHBOARD_BASIC_AUTH_USERNAME={user}
      - HERMES_DASHBOARD_BASIC_AUTH_PASSWORD={password}
      - HERMES_DASHBOARD_BASIC_AUTH_SECRET={secret}

    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "2"
          memory: 2048M
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.{router}.rule=Host(`{domain}`)"
        - "traefik.http.routers.{router}.entrypoints=websecure"
        - "traefik.http.routers.{router}.tls.certresolver=letsencryptresolver"
        - "traefik.http.routers.{router}.service={svc}"
        - "traefik.http.services.{svc}.loadbalancer.server.port=9119"
        - "traefik.http.services.{svc}.loadbalancer.passHostHeader=true"
      restart_policy:
        condition: any
        delay: 10s
        max_attempts: 5
        window: 120s

## --------------------------- VOLUMES --------------------------- ##

volumes:
  {vol_data}:
    external: true
    name: {vol_data}

## --------------------------- NETWORKS --------------------------- ##

networks:
  {network}:
    external: true
    name: {network}
"""


def install(*, domain: str, user: str = "admin", password: str = "", instance_id: str = "", instance_num: int = 0, **_) -> dict:
    if not instance_id:
        instance_id, instance_num = registry.next_instance_id("hermes")
    stack_name = instance_id
    suffix = f"_{instance_num}" if instance_num > 1 else ""
    router = f"hermes{suffix}"
    svc = f"hermes{suffix}"
    vol_data = f"hermes{suffix}_data"

    domain = checks.normalize_domain(domain)
    if not checks.validate_domain_name(domain):
        return {"ok": False, "error": "dominio_invalido"}
    user = user or "admin"
    password = password or secrets.token_urlsafe(12)
    secret = secrets.token_hex(32)

    subprocess.run(["docker", "volume", "create", vol_data], check=False, capture_output=True)

    yaml = TEMPLATE.format(
        network=NETWORK, domain=domain,
        user=user, password=password, secret=secret,
        router=router, svc=svc, vol_data=vol_data,
    )
    yaml_path = Path(f"/root/{stack_name}.yaml")
    yaml_path.write_text(yaml, encoding="utf-8")

    result = portainer_client.create_swarm_stack(stack_name, yaml)
    if not result.get("ok"):
        r = subprocess.run(
            ["docker", "stack", "deploy", "--prune", "--resolve-image", "always", "-c", str(yaml_path), stack_name],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return {"ok": False, "error": "deploy_failed", "detail": result, "cli": r.stderr}

    creds = {"url": f"https://{domain}", "user": user, "password": password}

    Path("/root/dados_vps").mkdir(parents=True, exist_ok=True)
    dados_file = f"dados_{instance_id}"
    Path(f"/root/dados_vps/{dados_file}").write_text(
        f"""[ HERMES — {instance_id} ]

Dominio: https://{domain}
Usuario: {user}
Senha: {password}
Stack: {stack_name}
Instancia: #{instance_num}
""",
        encoding="utf-8",
    )

    registry.register(
        "hermes", instance_id, instance_num,
        stack_name=stack_name, domain=domain,
        credentials=creds, params={"domain": domain, "user": user},
    )

    v = validate.wait_stack(stack_name, expected_services=["hermes"], retries=4, delay=10)
    return {
        "ok": True,
        "stack": stack_name,
        "instance_id": instance_id,
        "instance_num": instance_num,
        "domain": domain,
        "credentials": creds,
        "validate": v,
        "dns_required": True,
        "message": f"Aponte o A record de {domain} para {checks.public_ip()}",
    }


def meta() -> dict:
    return {
        "id": "hermes",
        "name": "Hermes Agent",
        "description": "Gateway + dashboard Hermes (nousresearch) com Traefik",
        "requires_base": True,
        "requires_domain": True,
        "multi_instance": True,
        "fields": [
            {"key": "domain", "label": "Dominio (ex: hermes.seudominio.com)", "default": ""},
            {"key": "user", "label": "Usuario dashboard", "default": "admin"},
            {"key": "password", "label": "Senha (vazio = gerar)", "default": ""},
        ],
    }
