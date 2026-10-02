"""Evolution API stack installer — multi-instance aware."""
from __future__ import annotations

import secrets
import subprocess
from pathlib import Path

from .. import checks, portainer_client, registry, validate

NETWORK = __import__("os").environ.get("SETUPIMPA_NETWORK", "network_public")

TEMPLATE = """version: "3.7"
services:

## --------------------------- IMPA --------------------------- ##

  evolution:
    image: atendai/evolution-api:v2.2.3
    volumes:
      - {vol_instances}:/evolution/instances
      - {vol_store}:/evolution/store
    networks:
      - {network}
    environment:
      - SERVER_URL=https://{domain}
      - AUTHENTICATION_API_KEY={api_key}
      - AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true
      - LANGUAGE=pt
      - CONFIG_SESSION_PHONE_CLIENT=SetupImpa
      - CONFIG_SESSION_PHONE_NAME=Chrome
      - QRCODE_LIMIT=1902
      - DATABASE_ENABLED=false
      - CACHE_REDIS_ENABLED=false
      - LOG_LEVEL=ERROR,WARN,DEBUG,INFO,LOG,WEBHOOKS
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      labels:
        - traefik.enable=true
        - traefik.http.routers.{router}.rule=Host(`{domain}`)
        - traefik.http.routers.{router}.entrypoints=websecure
        - traefik.http.routers.{router}.tls.certresolver=letsencryptresolver
        - traefik.http.routers.{router}.service={svc}
        - traefik.http.services.{svc}.loadbalancer.server.port=8080
        - traefik.http.services.{svc}.loadbalancer.passHostHeader=true

## --------------------------- IMPA --------------------------- ##

volumes:
  {vol_instances}:
    external: true
    name: {vol_instances}
  {vol_store}:
    external: true
    name: {vol_store}

networks:
  {network}:
    external: true
    name: {network}
"""


def install(*, domain: str, api_key: str = "", instance_id: str = "", instance_num: int = 0, **_) -> dict:
    # ── multi-instance resolution ──
    if not instance_id:
        instance_id, instance_num = registry.next_instance_id("evolution")
    stack_name = instance_id
    suffix = f"_{instance_num}" if instance_num > 1 else ""
    router = f"evolution{suffix}"
    svc = f"evolution{suffix}"
    vol_instances = f"evolution{suffix}_instances"
    vol_store = f"evolution{suffix}_store"

    domain = checks.normalize_domain(domain)
    if not checks.validate_domain_name(domain):
        return {"ok": False, "error": "dominio_invalido"}
    api_key = api_key or secrets.token_hex(16)

    for vol in (vol_instances, vol_store):
        subprocess.run(["docker", "volume", "create", vol], check=False, capture_output=True)

    yaml = TEMPLATE.format(
        network=NETWORK, domain=domain, api_key=api_key,
        router=router, svc=svc,
        vol_instances=vol_instances, vol_store=vol_store,
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

    creds = {"url": f"https://{domain}", "api_key": api_key}

    Path("/root/dados_vps").mkdir(parents=True, exist_ok=True)
    dados_file = f"dados_{instance_id}"
    Path(f"/root/dados_vps/{dados_file}").write_text(
        f"""[ EVOLUTION API — {instance_id} ]

Dominio: https://{domain}
API Key: {api_key}
Stack: {stack_name}
Instancia: #{instance_num}
""",
        encoding="utf-8",
    )

    registry.register(
        "evolution", instance_id, instance_num,
        stack_name=stack_name, domain=domain,
        credentials=creds, params={"domain": domain, "api_key": api_key},
    )

    v = validate.wait_stack(stack_name, expected_services=["evolution"], retries=4, delay=10)
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
        "id": "evolution",
        "name": "Evolution API",
        "description": "API WhatsApp (Evolution v2) atras do Traefik",
        "requires_base": True,
        "requires_domain": True,
        "multi_instance": True,
        "fields": [
            {"key": "domain", "label": "Dominio (ex: evo.seudominio.com)", "default": ""},
            {"key": "api_key", "label": "API Key (vazio = gerar)", "default": ""},
        ],
    }
