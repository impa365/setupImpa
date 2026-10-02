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
    image: postgres:{version}
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


def install(*, version: str = "16-alpine", user: str = "postgres", password: str = "", database: str = "postgres", instance_id: str = "", instance_num: int = 0, **_) -> dict:
    if not instance_id:
        instance_id, instance_num = registry.next_instance_id("postgres")
    stack_name = instance_id
    suffix = f"_{instance_num}" if instance_num > 1 else ""
    vol_data = f"postgres{suffix}_data"

    password = password or secrets.token_urlsafe(16)
    user = user or "postgres"
    database = database or "postgres"
    version = (version or "16-alpine").strip()

    subprocess.run(["docker", "volume", "create", vol_data], check=False, capture_output=True)

    yaml = TEMPLATE.format(
        network=NETWORK, user=user, password=password, database=database,
        vol_data=vol_data, version=version,
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


def get_available_instances() -> list[dict]:
    """List all running/configured PostgreSQL instances."""
    instances = registry.list_by_app("postgres")
    out = []
    seen = set()
    for inst in instances:
        iid = inst.get("instance_id", "")
        seen.add(iid)
        creds = inst.get("credentials", {})
        out.append({
            "instance_id": iid,
            "instance_num": inst.get("instance_num", 1),
            "host": creds.get("host", f"{iid}_postgres"),
            "port": creds.get("port", 5432),
            "user": creds.get("user", "postgres"),
            "password": creds.get("password", ""),
            "database": creds.get("database", "postgres"),
            "label": f"PostgreSQL #{inst.get('instance_num', 1)} ({iid})",
        })

    # Fallback: check if 'postgres' stack exists in Swarm even if not yet in registry
    if "postgres" not in seen and checks.stack_exists("postgres"):
        dados_file = Path("/root/dados_vps/dados_postgres")
        user = "postgres"
        pwd = ""
        if dados_file.exists():
            for line in dados_file.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("Usuario:"):
                    user = line.split(":", 1)[1].strip()
                elif line.startswith("Senha:"):
                    pwd = line.split(":", 1)[1].strip()
        out.insert(0, {
            "instance_id": "postgres",
            "instance_num": 1,
            "host": "postgres_postgres",
            "port": 5432,
            "user": user,
            "password": pwd,
            "database": "postgres",
            "label": "PostgreSQL #1 (postgres)",
        })
    return out


def ensure_database(db_instance: str, db_name: str) -> bool:
    """Ensure a database exists inside the PostgreSQL container."""
    if not db_name or db_name == "postgres":
        return True
    try:
        # Find container id by service name
        cmd = (
            f"cid=$(docker ps -q --filter name={db_instance}_postgres | head -n 1); "
            f'if [ -n "$cid" ]; then '
            f'  docker exec "$cid" psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = \'{db_name}\'" | grep -q 1 || '
            f'  docker exec "$cid" psql -U postgres -c "CREATE DATABASE {db_name};"; '
            f"fi"
        )
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        return r.returncode == 0
    except Exception:
        return False


def meta() -> dict:
    return {
        "id": "postgres",
        "name": "PostgreSQL",
        "description": "Banco de Dados relacional PostgreSQL de alta performance",
        "requires_base": True,
        "requires_domain": False,
        "multi_instance": True,
        "fields": [
            {
                "key": "version",
                "label": "Versão do PostgreSQL",
                "type": "select",
                "options": [
                    {"value": "16-alpine", "label": "PostgreSQL 16 (Alpine - Recomendada)"},
                    {"value": "15-alpine", "label": "PostgreSQL 15 (Alpine)"},
                    {"value": "17-alpine", "label": "PostgreSQL 17 (Alpine - Mais recente)"},
                    {"value": "16", "label": "PostgreSQL 16 (Debian standard)"},
                ],
                "default": "16-alpine",
            },
            {"key": "user", "label": "Usuário", "default": "postgres"},
            {"key": "password", "label": "Senha (vazio = gerar automaticamente)", "default": ""},
            {"key": "database", "label": "Database Inicial", "default": "postgres"},
        ],
    }
