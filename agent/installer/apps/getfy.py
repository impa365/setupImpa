"""Getfy (checkout/payments) stack installer — app + queue + scheduler + redis — multi-instance aware."""
from __future__ import annotations

import secrets
import subprocess
from pathlib import Path

from .. import checks, portainer_client, registry, validate
from . import postgres

NETWORK = __import__("os").environ.get("SETUPIMPA_NETWORK", "network_public")

TEMPLATE = r'''version: "3.8"
services:

## --------------------------- GETFY APP --------------------------- ##

  getfy_app:
    image: impa365/getfy-opensource:pgsql-fix

    volumes:
      - {vol_storage}:/var/www/html/storage
      - {vol_env}:/var/www/html/.docker

    networks:
      - {network}

    environment:
      - APP_ENV=production
      - APP_DEBUG=false
      - APP_INSTALLED=true
      - APP_AUTO_MIGRATE=true
      - GETFY_APP_URL=https://{domain}
      - APP_URL=https://{domain}
      - SESSION_SECURE_COOKIE=true
      - TZ=America/Sao_Paulo
      - DB_CONNECTION=pgsql
      - DB_HOST={db_host}
      - DB_PORT=5432
      - DB_DATABASE={db_name}
      - DB_USERNAME={db_user}
      - DB_PASSWORD={db_pass}
      - REDIS_CLIENT=predis
      - REDIS_HOST={redis_svc}
      - REDIS_PORT=6379
      - REDIS_PASSWORD=null
      - CACHE_STORE=redis
      - QUEUE_CONNECTION=redis
      - SESSION_DRIVER=file
      - GETFY_DOCKER=true
      - GETFY_RUN_SETUP=true
      - PORT=80

    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "2"
          memory: 1024M
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.{router}.rule=Host(`{domain}`)"
        - "traefik.http.routers.{router}.entrypoints=websecure"
        - "traefik.http.routers.{router}.tls.certresolver=letsencryptresolver"
        - "traefik.http.routers.{router}.service={svc}"
        - "traefik.http.routers.{router}.middlewares={mw_name}"
        - "traefik.http.middlewares.{mw_name}.headers.customResponseHeaders.X-Frame-Options="
        - 'traefik.http.middlewares.{mw_name}.headers.customResponseHeaders.Content-Security-Policy=default-src ''self''; frame-ancestors ''self'' {frame_ancestors}; script-src ''self'' ''unsafe-inline'' ''unsafe-eval'' https://js.stripe.com https://sdk.mercadopago.com https://http2.mlstatic.com https://*.mlstatic.com https://checkout.pagar.me https://cdn.cajupay.com.br https://www.paypal.com https://www.sandbox.paypal.com https://*.paypal.com https://*.paypalobjects.com https://connect.facebook.net https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://analytics.tiktok.com https://cdn.utmify.com.br https://challenges.cloudflare.com https://www.youtube.com https://youtube.com https://s.ytimg.com https://static.cloudflareinsights.com; style-src ''self'' ''unsafe-inline'' https://fonts.googleapis.com; img-src ''self'' data: https: blob:; font-src ''self'' https://fonts.gstatic.com; connect-src ''self'' https: wss: blob:; frame-src ''self'' https://js.stripe.com https://hooks.stripe.com https://m.stripe.network https://www.paypal.com https://www.sandbox.paypal.com https://*.paypal.com https://*.paypalobjects.com https://www.mercadopago.com https://*.mercadopago.com https://*.mercadopago.com.br https://www.youtube-nocookie.com https://youtube-nocookie.com https://www.youtube.com https://youtube.com https://challenges.cloudflare.com https://*.cajupay.com.br https://checkout.pagar.me https://www.facebook.com https://*.facebook.com https://connect.facebook.net; media-src ''self'' https: blob:; worker-src ''self'' blob:'
        - "traefik.http.services.{svc}.loadbalancer.server.port=80"
        - "traefik.http.services.{svc}.loadbalancer.passHostHeader=true"
      update_config:
        parallelism: 1
        delay: 10s
        order: stop-first
        failure_action: rollback
      restart_policy:
        condition: any
        delay: 10s
        max_attempts: 5
        window: 120s

    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:80/up || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 180s

## --------------------------- GETFY QUEUE WORKER --------------------------- ##

  getfy_queue:
    image: impa365/getfy-opensource:pgsql-fix
    command: ["php", "artisan", "queue:work", "--sleep=3", "--tries=3", "--timeout=0", "--memory=128"]

    volumes:
      - {vol_storage}:/var/www/html/storage
      - {vol_env}:/var/www/html/.docker

    networks:
      - {network}

    environment:
      - APP_ENV=production
      - APP_DEBUG=false
      - APP_INSTALLED=true
      - APP_AUTO_MIGRATE=false
      - GETFY_APP_URL=https://{domain}
      - APP_URL=https://{domain}
      - SESSION_SECURE_COOKIE=true
      - TZ=America/Sao_Paulo
      - DB_CONNECTION=pgsql
      - DB_HOST={db_host}
      - DB_PORT=5432
      - DB_DATABASE={db_name}
      - DB_USERNAME={db_user}
      - DB_PASSWORD={db_pass}
      - REDIS_CLIENT=predis
      - REDIS_HOST={redis_svc}
      - REDIS_PORT=6379
      - REDIS_PASSWORD=null
      - CACHE_STORE=redis
      - QUEUE_CONNECTION=redis
      - SESSION_DRIVER=file
      - GETFY_DOCKER=true
      - GETFY_RUN_SETUP=false

    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "1"
          memory: 512M
      restart_policy:
        condition: any
        delay: 10s
        max_attempts: 3

## --------------------------- GETFY SCHEDULER --------------------------- ##

  getfy_scheduler:
    image: impa365/getfy-opensource:pgsql-fix
    command: ["php", "artisan", "schedule:work"]

    volumes:
      - {vol_storage}:/var/www/html/storage
      - {vol_env}:/var/www/html/.docker

    networks:
      - {network}

    environment:
      - APP_ENV=production
      - APP_DEBUG=false
      - APP_INSTALLED=true
      - APP_AUTO_MIGRATE=false
      - GETFY_APP_URL=https://{domain}
      - APP_URL=https://{domain}
      - SESSION_SECURE_COOKIE=true
      - TZ=America/Sao_Paulo
      - DB_CONNECTION=pgsql
      - DB_HOST={db_host}
      - DB_PORT=5432
      - DB_DATABASE={db_name}
      - DB_USERNAME={db_user}
      - DB_PASSWORD={db_pass}
      - REDIS_CLIENT=predis
      - REDIS_HOST={redis_svc}
      - REDIS_PORT=6379
      - REDIS_PASSWORD=null
      - CACHE_STORE=redis
      - QUEUE_CONNECTION=redis
      - SESSION_DRIVER=file
      - GETFY_DOCKER=true
      - GETFY_RUN_SETUP=false

    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
      restart_policy:
        condition: any
        delay: 10s
        max_attempts: 3

## --------------------------- GETFY REDIS --------------------------- ##

  {redis_svc}:
    image: redis:latest
    command: ["redis-server", "--appendonly", "yes", "--port", "6379"]

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
          cpus: "1"
          memory: 512M

## --------------------------- VOLUMES --------------------------- ##

volumes:
  {vol_storage}:
    external: true
    name: {vol_storage}
  {vol_env}:
    external: true
    name: {vol_env}
  {vol_redis}:
    external: true
    name: {vol_redis}

## --------------------------- NETWORKS --------------------------- ##

networks:
  {network}:
    external: true
    name: {network}
'''


def install(
    *,
    domain: str,
    db_instance: str = "",
    db_host: str = "",
    db_name: str = "getfy",
    db_user: str = "postgres",
    db_pass: str = "",
    frame_ancestors: str = "",
    instance_id: str = "",
    instance_num: int = 0,
    **_,
) -> dict:
    # ── multi-instance resolution ──
    if not instance_id:
        instance_id, instance_num = registry.next_instance_id("getfy")
    stack_name = instance_id
    suffix = f"_{instance_num}" if instance_num > 1 else ""
    router = f"getfy{suffix}"
    svc = f"getfy{suffix}"
    mw_name = f"getfy{suffix}-embed"
    redis_svc = f"getfy{suffix}_redis"
    vol_storage = f"getfy{suffix}_storage"
    vol_env = f"getfy{suffix}_env"
    vol_redis = f"getfy{suffix}_redis"

    domain = checks.normalize_domain(domain)
    if not checks.validate_domain_name(domain):
        return {"ok": False, "error": "dominio_invalido"}

    if db_instance and not db_host:
        inst = registry.get(db_instance)
        if inst and inst.get("credentials"):
            db_host = inst["credentials"].get("host", f"{db_instance}_postgres")
            db_user = inst["credentials"].get("user", "postgres")
            db_pass = inst["credentials"].get("password", "")
        else:
            db_host = f"{db_instance}_postgres"
            dados_file = Path(f"/root/dados_vps/dados_{db_instance}")
            if dados_file.exists():
                for line in dados_file.read_text(encoding="utf-8", errors="replace").splitlines():
                    if line.startswith("Usuario:"):
                        db_user = line.split(":", 1)[1].strip()
                    elif line.startswith("Senha:"):
                        db_pass = line.split(":", 1)[1].strip()

    db_host = db_host or "postgres_postgres"
    db_pass = db_pass or secrets.token_hex(16)
    db_name = db_name or "getfy"
    db_user = db_user or "postgres"
    frame_ancestors = frame_ancestors.strip() or f"https://{domain}"

    # Cria a database "getfy" no container PostgreSQL selecionado
    target_pg = db_instance or "postgres"
    postgres.ensure_database(target_pg, db_name)

    for vol in (vol_storage, vol_env, vol_redis):
        subprocess.run(["docker", "volume", "create", vol], check=False, capture_output=True)

    network = checks.active_network()

    yaml = TEMPLATE.format(
        network=network, domain=domain,
        db_host=db_host, db_name=db_name, db_user=db_user, db_pass=db_pass,
        frame_ancestors=frame_ancestors,
        router=router, svc=svc, mw_name=mw_name,
        redis_svc=redis_svc,
        vol_storage=vol_storage, vol_env=vol_env, vol_redis=vol_redis,
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

    creds = {
        "url": f"https://{domain}",
        "setup_url": f"https://{domain}/docker-setup",
        "db_host": db_host,
        "db_name": db_name,
        "db_user": db_user,
        "db_pass": db_pass,
    }

    Path("/root/dados_vps").mkdir(parents=True, exist_ok=True)
    dados_file = f"dados_{instance_id}"
    Path(f"/root/dados_vps/{dados_file}").write_text(
        f"""[ GETFY — {instance_id} ]

Dominio: https://{domain}
Setup: https://{domain}/docker-setup

Banco:
  Host: {db_host}
  Database: {db_name}
  Usuario: {db_user}
  Senha: {db_pass}

Stack: {stack_name}
Instancia: #{instance_num}
Obs: Apos o deploy, acesse {domain}/docker-setup para criar o admin.
Queue e scheduler NAO fazem migrate (APP_AUTO_MIGRATE=false).
""",
        encoding="utf-8",
    )

    registry.register(
        "getfy", instance_id, instance_num,
        stack_name=stack_name, domain=domain,
        credentials=creds,
        params={"domain": domain, "db_host": db_host, "db_name": db_name, "db_user": db_user},
    )

    v = validate.wait_stack(
        stack_name,
        expected_services=["getfy_app", "getfy_queue", "getfy_scheduler", redis_svc],
        retries=6, delay=15,
    )
    return {
        "ok": True,
        "stack": stack_name,
        "instance_id": instance_id,
        "instance_num": instance_num,
        "domain": domain,
        "credentials": creds,
        "validate": v,
        "dns_required": True,
        "message": f"Aponte o A record de {domain} para {checks.public_ip()}. Depois acesse {domain}/docker-setup para criar o admin.",
    }


def meta() -> dict:
    return {
        "id": "getfy",
        "name": "Getfy",
        "description": "Checkout / pagamentos (app + queue + scheduler + Redis) com Traefik e embed CSP",
        "requires_base": True,
        "requires_domain": True,
        "requires_postgres": True,
        "multi_instance": True,
        "fields": [
            {"key": "domain", "label": "Dominio (ex: pay.seudominio.com)", "default": ""},
            {"key": "db_instance", "label": "Banco PostgreSQL", "default": ""},
            {"key": "db_host", "label": "Host Postgres (stack interna)", "default": "postgres_postgres"},
            {"key": "db_name", "label": "Database", "default": "getfy"},
            {"key": "db_user", "label": "Usuario DB", "default": "postgres"},
            {"key": "db_pass", "label": "Senha DB (vazio = gerar)", "default": ""},
            {"key": "frame_ancestors", "label": "frame-ancestors CSP (embed CRM, ex: https://crm.dominio.com)", "default": ""},
        ],
    }
