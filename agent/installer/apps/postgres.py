"""Postgres stack installer — multi-instance aware."""
from __future__ import annotations

import secrets
import subprocess
from pathlib import Path

from .. import checks, portainer_client, registry, validate

NETWORK = __import__("os").environ.get("SETUPIMPA_NETWORK", "network_public")

TEMPLATE = """version: "3.7"
services:

## --------------------------- IMPA --------------------------- ##

  postgres:
    image: postgres:16
    networks:
      - {network}
    volumes:
      - {vol_data}:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER={user}
      - POSTGRES_PASSWORD={password}
      - POSTGRES_DB={database}
    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager

## --------------------------- IMPA --------------------------- ##

volumes:
  {vol_data}:
    external: true
    name: {vol_data}

networks:
  {network}:
    external: true
    name: {network}
"""


def install(*, user: str = "postgres", password: str = "", database: str = "postgres", instance_id: str = "", instance_num: int = 0, **_) -> dict:
    if not instance_id:
        instance_id, instance_num = registry.next_instance_id("postgres")
    stack_name = instance_id
    suffix = f"_{instance_num}" if instance_num > 1 else ""
    vol_data = f"postgres{suffix}_data"

    password = password or secrets.token_urlsafe(16)
    user = user or "postgres"
    database = database or "postgres"

    subprocess.run(["docker", "volume", "create", vol_data], check=False, capture_output=True)

    yaml = TEMPLATE.format(
        network=NETWORK, user=user, password=password, database=database,
        vol_data=vol_data,
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

    # The internal hostname in swarm is <stack_name>_<service_name>
    host_internal = f"{stack_name}_postgres"

    creds = {
        "host": host_internal,
        "port": 5432,
        "user": user,
        "password": password,
        "database": database,
    }

    Path("/root/dados_vps").mkdir(parents=True, exist_ok=True)
    dados_file = f"dados_{instance_id}"
    Path(f"/root/dados_vps/{dados_file}").write_text(
        f"""[ POSTGRES — {instance_id} ]

Host: {host_internal}
Porta: 5432
Usuario: {user}
Senha: {password}
Database: {database}
Stack: {stack_name}
Instancia: #{instance_num}
""",
        encoding="utf-8",
    )

    registry.register(
        "postgres", instance_id, instance_num,
        stack_name=stack_name,
        credentials=creds, params={"user": user, "database": database},
    )

    v = validate.wait_stack(stack_name, expected_services=["postgres"], retries=4, delay=8)
    return {
        "ok": True,
        "stack": stack_name,
        "instance_id": instance_id,
        "instance_num": instance_num,
        "credentials": creds,
        "validate": v,
        "dns_required": False,
    }


def meta() -> dict:
    return {
        "id": "postgres",
        "name": "PostgreSQL",
        "description": "Banco PostgreSQL 16 na rede interna Swarm",
        "requires_base": True,
        "requires_domain": False,
        "multi_instance": True,
        "fields": [
            {"key": "user", "label": "Usuario", "default": "postgres"},
            {"key": "password", "label": "Senha (vazio = gerar)", "default": ""},
            {"key": "database", "label": "Database", "default": "postgres"},
        ],
    }
