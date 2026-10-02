"""9Router stack installer — AI Gateway (Claude Code, Codex, Cursor, Cline, Copilot → 40+ providers)."""
from __future__ import annotations

import secrets
import subprocess
from pathlib import Path

from .. import checks, portainer_client, registry, validate

NETWORK = __import__("os").environ.get("SETUPIMPA_NETWORK", "network_public")

TEMPLATE = """version: "3.8"

services:

## --------------------------- 9ROUTER (AI Gateway) --------------------------- ##

  nine_router:
    image: {image}

    volumes:
      - {vol_data}:/app/data

    networks:
      - {network}

    environment:
      - NODE_ENV=production
      - PORT=20128
      - HOSTNAME=0.0.0.0
      - DATA_DIR=/app/data

      ## URLs publicas
      - BASE_URL=https://{domain}
      - NEXT_PUBLIC_BASE_URL=https://{domain}
      - CLOUD_URL=https://9router.com
      - NEXT_PUBLIC_CLOUD_URL=https://9router.com

      ## Auth / seguranca
      - AUTH_COOKIE_SECURE=true
      - REQUIRE_API_KEY=true
      - JWT_SECRET={jwt_secret}
      - API_KEY_SECRET={api_key_secret}
      - MACHINE_ID_SALT={machine_id_salt}
      - INITIAL_PASSWORD={initial_password}

      ## Ops
      - ENABLE_REQUEST_LOGS=false
      - OBSERVABILITY_ENABLED=true

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
        - "traefik.http.services.{svc}.loadbalancer.server.port=20128"
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


def install(
    *,
    domain: str,
    image: str = "decolua/9router:latest",
    initial_password: str = "",
    instance_id: str = "",
    instance_num: int = 0,
    **_,
) -> dict:
    if not instance_id:
        instance_id, instance_num = registry.next_instance_id("9router")
    elif not instance_num:
        instance_num = int("".join(filter(str.isdigit, instance_id)) or "1")

    suffix = f"_{instance_num}" if instance_num > 1 else ""
    router = f"9router{suffix}"
    svc = f"9router{suffix}"
    vol_data = f"9router{suffix}_data"

    domain = (domain or "").strip()
    checks.validate_domain(domain)
    image = (image or "decolua/9router:latest").strip()

    initial_password = initial_password or secrets.token_urlsafe(16)
    jwt_secret = secrets.token_urlsafe(48)
    api_key_secret = secrets.token_hex(32)
    machine_id_salt = secrets.token_hex(32)

    # Cria volume no Docker
    subprocess.run(["docker", "volume", "create", vol_data], capture_output=True, text=True)

    network = checks.active_network()

    compose = TEMPLATE.format(
        domain=domain,
        image=image,
        router=router,
        svc=svc,
        vol_data=vol_data,
        network=network,
        jwt_secret=jwt_secret,
        api_key_secret=api_key_secret,
        machine_id_salt=machine_id_salt,
        initial_password=initial_password,
    )

    client = portainer_client.get_client()
    stack = client.deploy_swarm_stack(name=instance_id, compose_yaml=compose)

    dados = Path("/root/dados_vps")
    dados.mkdir(parents=True, exist_ok=True)
    creds_file = dados / f"{instance_id}_credentials.txt"
    creds_content = (
        f"Instância: {instance_id} (#{instance_num})\n"
        f"Data: {Path('/etc/timezone').read_text().strip() if Path('/etc/timezone').exists() else 'UTC'}\n"
        f"Dashboard: https://{domain}\n"
        f"Imagem: {image}\n"
        f"Usuário Inicial: admin\n"
        f"Senha Inicial (1º Login): {initial_password}\n"
        f"API Key Secret: {api_key_secret}\n"
        f"Machine ID Salt: {machine_id_salt}\n"
    )
    creds_file.write_text(creds_content)

    post_report = validate.run_post_install_validation(
        instance_id,
        domain=domain,
        expected_services=["nine_router"],
    )

    registry.register_instance(
        "9router",
        instance_id,
        instance_num,
        domain=domain,
        stack_id=stack.get("Id"),
        extra={"image": image},
    )

    return {
        "status": "installed",
        "instance_id": instance_id,
        "instance_num": instance_num,
        "domain": domain,
        "image": image,
        "initial_password": initial_password,
        "credentials_file": str(creds_file),
        "post_report": post_report,
    }


def uninstall(instance_id: str = "9router") -> dict:
    client = portainer_client.get_client()
    res = client.delete_swarm_stack(instance_id)
    registry.unregister_instance("9router", instance_id)
    return {"status": "uninstalled", "instance_id": instance_id, "detail": res}


def get_credentials(instance_id: str = "9router") -> str:
    creds_file = Path("/root/dados_vps") / f"{instance_id}_credentials.txt"
    if creds_file.exists():
        return creds_file.read_text()
    return "Nenhum arquivo de credenciais encontrado para esta instância."


def meta() -> dict:
    return {
        "id": "9router",
        "name": "9Router AI Gateway",
        "category": "ai",
        "description": "Gateway e proxy universal de IA para Claude Code, Codex, Cursor, Cline e Copilot conectando a mais de 40 provedores com dashboard visual.",
        "multi_instance": True,
        "requires_postgres": False,
        "fields": [
            {"key": "domain", "label": "Domínio (ex: 9router.meusite.com)", "required": True},
            {
                "key": "image",
                "label": "Imagem / Versão do 9Router",
                "type": "select",
                "options": [
                    {"value": "decolua/9router:latest", "label": "decolua/9router:latest (Oficial - Recomendada)"},
                    {"value": "decolua/9router:0.5.81", "label": "decolua/9router:0.5.81 (Oficial estável)"},
                    {"value": "impa365/9router:0.5.81", "label": "impa365/9router:0.5.81 (Build IMPA 365)"},
                ],
                "default": "decolua/9router:latest",
                "required": False,
            },
            {
                "key": "initial_password",
                "label": "Senha Inicial de Acesso (Opcional - gerada automaticamente)",
                "required": False,
            },
        ],
    }
