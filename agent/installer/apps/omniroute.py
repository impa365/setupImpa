"""OmniRoute stack installer — AI/LLM Gateway & Proxy (multi-instance aware)."""
from __future__ import annotations

import secrets
import subprocess
from pathlib import Path

from .. import checks, portainer_client, registry, validate

NETWORK = __import__("os").environ.get("SETUPIMPA_NETWORK", "network_public")

TEMPLATE = """version: "3.7"

services:

## --------------------------- OMNIROUTE (AI Router & Gateway) --------------------------- ##

  omniroute:
    image: diegosouzapw/omniroute:{version}

    volumes:
      - {vol_data}:/app/data

    networks:
      - {network}

    environment:
      - NODE_ENV=production
      - OMNIROUTE_MEMORY_MB=3072
      - PORT=20128
      - DASHBOARD_PORT=20128
      - API_PORT=20129
      - API_HOST=0.0.0.0
      - DATA_DIR=/app/data
      - BASE_URL=https://{domain}
      - AUTH_COOKIE_SECURE=true
      - REDIS_URL=redis://{redis_svc}:6379
      - JWT_SECRET={jwt_secret}
      - API_KEY_SECRET={api_key_secret}
      - STORAGE_ENCRYPTION_KEY={storage_encryption_key}
      - INITIAL_PASSWORD={initial_password}
      - REQUIRE_API_KEY=true
      - APP_LOG_LEVEL=info

    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "2"
          memory: 6144M
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.{router}.rule=Host(`{domain}`)"
        - "traefik.http.routers.{router}.entrypoints=websecure"
        - "traefik.http.routers.{router}.priority=1"
        - "traefik.http.routers.{router}.tls.certresolver=letsencryptresolver"
        - "traefik.http.routers.{router}.service={svc}"
        - "traefik.http.routers.{router}.middlewares={mw_name}"
        - "traefik.http.middlewares.{mw_name}.headers.customResponseHeaders.X-Frame-Options="
        - "traefik.http.middlewares.{mw_name}.headers.customResponseHeaders.Content-Security-Policy=default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors https://impacrm.impa365.com https://impacrm.impa365.cloud; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https: ws: wss:; worker-src 'self' blob:; manifest-src 'self'"
        - "traefik.http.services.{svc}.loadbalancer.server.port=20128"
        - "traefik.http.services.{svc}.loadbalancer.passHostHeader=true"

  {redis_svc}:
    image: redis:7-alpine
    command: redis-server --save 60 1 --loglevel warning --appendonly yes
    volumes:
      - {vol_redis}:/data
    networks:
      - {network}
    deploy:
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "0.5"
          memory: 512M

volumes:
  {vol_data}:
    external: true
    name: {vol_data}
  {vol_redis}:
    external: true
    name: {vol_redis}

networks:
  {network}:
    external: true
    name: {network}
"""


def install(
    *,
    domain: str,
    version: str = "3.8.50-web",
    initial_password: str = "",
    instance_id: str = "",
    instance_num: int = 0,
    **_,
) -> dict:
    if not instance_id:
        instance_id, instance_num = registry.next_instance_id("omniroute")
    elif not instance_num:
        instance_num = int("".join(filter(str.isdigit, instance_id)) or "1")

    suffix = f"_{instance_num}" if instance_num > 1 else ""
    router = f"omniroute{suffix}"
    svc = f"omniroute{suffix}"
    mw_name = f"omni{suffix}-embed"
    redis_svc = f"omniroute{suffix}_redis"
    vol_data = f"omniroute{suffix}_data"
    vol_redis = f"omniroute{suffix}_redis"

    domain = checks.normalize_domain((domain or "").strip())
    if not checks.validate_domain_name(domain):
        return {"ok": False, "error": "dominio_invalido"}
    version = (version or "3.8.50-web").strip()

    initial_password = initial_password or secrets.token_urlsafe(16)
    jwt_secret = secrets.token_urlsafe(48)
    api_key_secret = secrets.token_hex(32)
    storage_encryption_key = secrets.token_hex(32)

    # Garante volumes persistentes no Docker host
    for vol in (vol_data, vol_redis):
        subprocess.run(["docker", "volume", "create", vol], capture_output=True, text=True)

    network = checks.active_network()

    compose = TEMPLATE.format(
        domain=domain,
        version=version,
        router=router,
        svc=svc,
        mw_name=mw_name,
        redis_svc=redis_svc,
        vol_data=vol_data,
        vol_redis=vol_redis,
        network=network,
        jwt_secret=jwt_secret,
        api_key_secret=api_key_secret,
        storage_encryption_key=storage_encryption_key,
        initial_password=initial_password,
    )

    stack_name = instance_id
    yaml_path = Path(f"/root/{stack_name}.yaml")
    yaml_path.write_text(compose, encoding="utf-8")
    result = portainer_client.create_swarm_stack(stack_name, compose)
    if not result.get("ok"):
        r = subprocess.run(
            ["docker", "stack", "deploy", "--prune", "--resolve-image", "always", "-c", str(yaml_path), stack_name],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return {"ok": False, "error": "deploy_failed", "detail": result, "cli": r.stderr}

    dados = Path("/root/dados_vps")
    dados.mkdir(parents=True, exist_ok=True)
    creds_file = dados / f"{instance_id}_credentials.txt"
    creds_content = (
        f"Instância: {instance_id} (#{instance_num})\n"
        f"Data: {Path('/etc/timezone').read_text().strip() if Path('/etc/timezone').exists() else 'UTC'}\n"
        f"Painel / Gateway: https://{domain}\n"
        f"Versão: {version}\n"
        f"Usuário Inicial: admin\n"
        f"Senha Inicial: {initial_password}\n"
        f"API Key Secret: {api_key_secret}\n"
        f"Storage Encryption Key: {storage_encryption_key}\n"
        f"Redis Interno: redis://{redis_svc}:6379\n"
    )
    creds_file.write_text(creds_content)

    post_report = validate.wait_stack(
        instance_id,
        expected_services=["omniroute", redis_svc],
        retries=6, delay=15,
    )

    registry.register(
        "omniroute", instance_id, instance_num,
        stack_name=instance_id, domain=domain,
        credentials={"url": f"https://{domain}", "user": "admin", "password": initial_password},
        params={"domain": domain, "version": version, "redis_svc": redis_svc},
    )

    return {
        "status": "installed",
        "instance_id": instance_id,
        "instance_num": instance_num,
        "domain": domain,
        "version": version,
        "initial_password": initial_password,
        "credentials_file": str(creds_file),
        "post_report": post_report,
    }


def uninstall(instance_id: str = "omniroute") -> dict:
    res = registry.remove_stack(instance_id)
    registry.unregister(instance_id)
    return {"status": "uninstalled", "instance_id": instance_id, "detail": res}


def get_credentials(instance_id: str = "omniroute") -> str:
    creds_file = Path("/root/dados_vps") / f"{instance_id}_credentials.txt"
    if creds_file.exists():
        return creds_file.read_text()
    return "Nenhum arquivo de credenciais encontrado para esta instância."


def meta() -> dict:
    return {
        "id": "omniroute",
        "name": "OmniRoute Gateway AI",
        "category": "ai",
        "description": "Roteador inteligente e gateway unificado de IA (OpenAI, Claude, Gemini, Groq, DeepSeek) com balanceamento de carga, rate limits e painel visual.",
        "multi_instance": True,
        "requires_postgres": False,
        "fields": [
            {"key": "domain", "label": "Domínio (ex: openapi.meusite.com)", "required": True},
            {
                "key": "version",
                "label": "Versão do OmniRoute",
                "type": "select",
                "options": [
                    {"value": "3.8.50-web", "label": "3.8.50-web (Recomendada / Painel Web)"},
                    {"value": "3.8.52-web", "label": "3.8.52-web"},
                    {"value": "latest", "label": "latest (Última versão)"},
                ],
                "default": "3.8.50-web",
                "required": False,
            },
            {
                "key": "initial_password",
                "label": "Senha Inicial do Admin (Opcional - gerada automaticamente)",
                "required": False,
            },
        ],
    }
