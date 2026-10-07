"""SetupOrion Engine — Dynamic adapter and executor for 100+ SetupOrion stacks.

Reuses and compiles official SetupOrion Swarm compose templates with zero manual rewrites,
handling automated Postgres provisioning, cryptographically secure secrets, Traefik routes,
and bidirectional compatibility with /root/dados_vps/dados_*.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import subprocess
from pathlib import Path
from typing import Any
from datetime import datetime, timezone

from . import checks, portainer_client, registry, validate

log = logging.getLogger("setupimpa.orion_engine")

CATALOG_PATH = Path(__file__).resolve().parent / "orion_catalog.json"
DADOS_VPS = Path("/root/dados_vps")

_CATALOG_CACHE: dict[str, dict[str, Any]] | None = None


def load_catalog() -> dict[str, dict[str, Any]]:
    """Load the Orion stack catalog from bundled JSON."""
    global _CATALOG_CACHE
    if _CATALOG_CACHE is not None:
        return _CATALOG_CACHE

    if CATALOG_PATH.exists():
        try:
            with open(CATALOG_PATH, "r", encoding="utf-8") as f:
                _CATALOG_CACHE = json.load(f)
                return _CATALOG_CACHE
        except Exception as e:
            log.error("Failed to load orion_catalog.json: %s", e)

    _CATALOG_CACHE = {}
    return _CATALOG_CACHE


def get_app(app_id: str) -> dict[str, Any] | None:
    cat = load_catalog()
    return cat.get(app_id)


def list_apps() -> list[dict[str, Any]]:
    cat = load_catalog()
    return list(cat.values())


def _get_postgres_password() -> str:
    """Retrieve postgres root password from dados_postgres or environment."""
    pg_file = DADOS_VPS / "dados_postgres"
    if pg_file.exists():
        try:
            for line in pg_file.read_text(encoding="utf-8", errors="replace").splitlines():
                if "Senha:" in line or "Password:" in line:
                    return line.split(":", 1)[1].strip()
        except Exception:
            pass
    return os.environ.get("POSTGRES_PASSWORD", "postgres")


def _ensure_postgres_database(db_name: str) -> bool:
    """Ensure a database exists in the active PostgreSQL container."""
    try:
        # Find postgres container
        res = subprocess.run(
            ["docker", "ps", "-q", "--filter", "name=postgres"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        cids = res.stdout.strip().splitlines()
        if not cids:
            log.warning("No running postgres container found to create DB '%s'", db_name)
            return False

        cid = cids[0]
        # Check if database already exists
        check_cmd = [
            "docker", "exec", cid,
            "psql", "-U", "postgres", "-tAc",
            f"SELECT 1 FROM pg_database WHERE datname='{db_name}'"
        ]
        chk = subprocess.run(check_cmd, capture_output=True, text=True, timeout=10)
        if chk.stdout.strip() == "1":
            log.info("Database '%s' already exists in postgres", db_name)
            return True

        # Create database
        create_cmd = [
            "docker", "exec", cid,
            "psql", "-U", "postgres", "-c",
            f'CREATE DATABASE "{db_name}";'
        ]
        cres = subprocess.run(create_cmd, capture_output=True, text=True, timeout=15)
        if cres.returncode == 0:
            log.info("Database '%s' created successfully in postgres", db_name)
            return True
        else:
            log.error("Failed to create DB '%s': %s", db_name, cres.stderr)
            return False
    except Exception as e:
        log.error("Error creating database '%s': %s", db_name, e)
        return False


def _ensure_docker_volume(vol_name: str) -> None:
    """Create external Docker volume if it does not already exist."""
    try:
        subprocess.run(
            ["docker", "volume", "create", vol_name],
            capture_output=True,
            timeout=10,
        )
    except Exception as e:
        log.warning("Could not pre-create volume %s: %s", vol_name, e)


def get_ui_fields(app_id: str) -> list[dict[str, Any]]:
    """Determine dynamic form fields needed for this Orion application."""
    app = get_app(app_id)
    if not app:
        return []

    fields = []
    inputs = app.get("inputs", [])
    tmpl = app.get("yaml_template", "")

    # Domain field (almost every web app needs a domain)
    has_domain = any("url" in inp.lower() or "dominio" in inp.lower() for inp in inputs) or "traefik.http.routers" in tmpl
    if has_domain:
        fields.append({
            "name": "domain",
            "label": "Domínio Principal da Aplicação",
            "type": "text",
            "placeholder": f"{app_id}.seudominio.com",
            "required": True,
            "help": f"Domínio ou subdomínio que apontará para o {app['name']}.",
        })

    # Secondary domains (e.g. webhook, viewer, api, etc.)
    for inp in inputs:
        inp_lower = inp.lower()
        if "webhook" in inp_lower:
            fields.append({
                "name": inp,
                "label": "Domínio do Webhook (opcional)",
                "type": "text",
                "placeholder": f"webhook-{app_id}.seudominio.com",
                "required": False,
                "help": "Subdomínio separado para endpoints de webhooks.",
            })
        elif "viewer" in inp_lower:
            fields.append({
                "name": inp,
                "label": "Domínio do Viewer / Player",
                "type": "text",
                "placeholder": f"bot-{app_id}.seudominio.com",
                "required": False,
                "help": "Subdomínio para visualização pública (ex: Typebot Viewer).",
            })
        elif "s3" in inp_lower and "url" in inp_lower:
            fields.append({
                "name": inp,
                "label": "Domínio da API S3",
                "type": "text",
                "placeholder": f"s3-{app_id}.seudominio.com",
                "required": False,
                "help": "Endpoint S3 para chamadas de API e uploads diretos.",
            })

    # SMTP / E-mail fields (collapsible or optional in UI)
    has_smtp = any("smtp" in inp.lower() or "mail" in inp.lower() for inp in inputs)
    if has_smtp:
        fields.append({
            "name": "smtp_email",
            "label": "E-mail do Administrador / SMTP (opcional)",
            "type": "text",
            "placeholder": "admin@seudominio.com",
            "required": False,
            "help": "Usado para envio de convites e redefinição de senhas.",
        })

    return fields


def render_compose(app_id: str, params: dict[str, Any], instance_id: str, instance_num: int) -> tuple[str, dict[str, str]]:
    """Compile and render SetupOrion YAML template with concrete environment values."""
    app = get_app(app_id)
    if not app:
        raise ValueError(f"App '{app_id}' não encontrado no catálogo do SetupOrion")

    tmpl = app["yaml_template"]

    # Bash-escaped dollar (``$$1`` in the source compiles to a literal ``$1``,
    # e.g. Traefik redirectregex backreferences). Protect it before any
    # substitution so it is not mistaken for a variable.
    rendered = tmpl.replace("$$", "\x00DOLLAR\x00")

    # SetupOrion bash multi-instance suffix, e.g. ``typebot${1:+_$1}``.
    # Handle both separator variants found in the catalog: ``${1:+_$1}``
    # (underscore) and ``${1:+-$1}`` (hyphen). For instance 1 the whole
    # expression collapses to "" (matches bash semantics).
    suffix = f"_{instance_num}" if instance_num > 1 else ""
    rendered = rendered.replace("${1:+_$1}", suffix)
    if instance_num > 1:
        rendered = rendered.replace("${1:+-$1}", f"-{instance_num}")
    else:
        rendered = rendered.replace("${1:+-$1}", "")

    # Active internal network
    network = checks.active_network()
    pg_password = _get_postgres_password()

    domain = (params.get("domain") or "").strip()
    smtp_email = (params.get("smtp_email") or f"admin@{domain or 'localhost'}").strip()

    generated_secrets: dict[str, str] = {
        "domain": domain,
        "instance_id": instance_id,
        "network": network,
    }

    # Standard SetupOrion bash variable substitutions
    replacements: dict[str, str] = {
        "$nome_rede_interna": network,
        "${nome_rede_interna}": network,
        "$senha_postgres": pg_password,
        "${senha_postgres}": pg_password,
        "$SENHA_POSTGRES": pg_password,
        "$senha_pgvector": pg_password,
        "${senha_pgvector}": pg_password,
    }

    # Match and replace domain variables
    for v in app.get("yaml_vars", []):
        v_lower = v.lower()
        if "url" in v_lower or "dominio" in v_lower:
            # Check if explicitly provided in params
            if v in params and params[v]:
                replacements[f"${v}"] = params[v]
                replacements[f"${{{v}}}"] = params[v]
            elif "webhook" in v_lower:
                wb_domain = params.get(v) or f"webhook.{domain}" if domain else "webhook.localhost"
                replacements[f"${v}"] = wb_domain
                replacements[f"${{{v}}}"] = wb_domain
            elif "viewer" in v_lower:
                vi_domain = params.get(v) or f"bot.{domain}" if domain else "bot.localhost"
                replacements[f"${v}"] = vi_domain
                replacements[f"${{{v}}}"] = vi_domain
            elif "s3" in v_lower:
                s3_domain = params.get(v) or f"s3.{domain}" if domain else "s3.localhost"
                replacements[f"${v}"] = s3_domain
                replacements[f"${{{v}}}"] = s3_domain
            elif "api" in v_lower:
                api_domain = params.get(v) or f"api.{domain}" if domain else "api.localhost"
                replacements[f"${v}"] = api_domain
                replacements[f"${{{v}}}"] = api_domain
            else:
                replacements[f"${v}"] = domain
                replacements[f"${{{v}}}"] = domain

        elif any(token in v_lower for token in ("key", "secret", "token", "salt", "pass", "pwd", "hash", "jwt", "apikey")):
            # Secret / Password / Key generation
            if v in params and params[v]:
                sec_val = params[v]
            else:
                length = 32 if any(x in v_lower for x in ("32", "base64", "cubejs", "salt", "secret_key_base")) else 16
                sec_val = secrets.token_hex(length)
            replacements[f"${v}"] = sec_val
            replacements[f"${{{v}}}"] = sec_val
            generated_secrets[v] = sec_val

        elif any(token in v_lower for token in ("email", "user", "mail")):
            val = params.get(v) or params.get("smtp_email") or "admin"
            replacements[f"${v}"] = val
            replacements[f"${{{v}}}"] = val

        elif "host" in v_lower or "smtp" in v_lower:
            val = params.get(v) or ("smtp.gmail.com" if "host" in v_lower else "465" if "porta" in v_lower else "true")
            replacements[f"${v}"] = val
            replacements[f"${{{v}}}"] = val

        else:
            # Generic fallback so no declared var is left unsubstituted.
            if v in params and params[v]:
                gval = params[v]
            elif "site" in v_lower or "empresa" in v_lower or "nome" in v_lower:
                gval = params.get(v) or app_id
            elif "sobre_ssl" in v_lower or "ssl" in v_lower:
                gval = "true"
            else:
                gval = ""
            replacements[f"${v}"] = gval
            replacements[f"${{{v}}}"] = gval
            if "site" in v_lower or "empresa" in v_lower or "nome" in v_lower:
                generated_secrets[v] = gval

    # Apply substitutions
    for k, v in replacements.items():
        rendered = rendered.replace(k, str(v))

    # Catch any leftover $var / ${var} pattern and replace with sensible defaults
    leftovers = re.findall(r"\$\{([a-zA-Z0-9_]+)\}|\$([a-zA-Z0-9_]+)", rendered)
    flat = {a or b for a, b in leftovers}
    for lvar in flat:
        l_lower = lvar.lower()
        if lvar in ("1", "opcao2"):
            r_val = ""
        elif "key" in l_lower or "secret" in l_lower:
            r_val = secrets.token_hex(16)
        elif "url" in l_lower or "domain" in l_lower:
            r_val = domain or "localhost"
        elif "email" in l_lower:
            r_val = smtp_email
        elif "site" in l_lower or "empresa" in l_lower or "nome" in l_lower:
            r_val = app_id
        else:
            r_val = ""
        # replace both brace styles
        rendered = rendered.replace(f"${{{lvar}}}", r_val)
        rendered = rendered.replace(f"${lvar}", r_val)

    # Clean backslash escaped backticks: \`host\` -> `host`
    rendered = rendered.replace(r"\`", "`")

    # Restore bash-escaped dollars to literal $
    rendered = rendered.replace("\x00DOLLAR\x00", "$")

    return rendered, generated_secrets


def install(
    *,
    app_id: str,
    domain: str = "",
    instance_id: str = "",
    instance_num: int = 0,
    **extra_params: Any,
) -> dict[str, Any]:
    """Install any SetupOrion application natively through Portainer API."""
    app = get_app(app_id)
    if not app:
        return {"ok": False, "error": f"Aplicação '{app_id}' não encontrada no catálogo SetupOrion"}

    instance_id = instance_id or (f"{app_id}_{instance_num}" if instance_num > 1 else app_id)

    log.info("Installing SetupOrion stack %s (instance %s, num %s)", app_id, instance_id, instance_num)

    # 1. Ensure databases in PostgreSQL if required
    pg_dbs = app.get("pg_dbs", [])
    suffix = f"_{instance_num}" if instance_num > 1 else ""
    for db_tmpl in pg_dbs:
        db_name = db_tmpl.replace("${1:+_$1}", suffix).replace(
            "${1:+-$1}", f"-{instance_num}" if instance_num > 1 else ""
        )
        log.info("Ensuring PostgreSQL database: %s", db_name)
        _ensure_postgres_database(db_name)

    # 2. Render Compose YAML
    params = {"domain": domain, **extra_params}
    try:
        yaml_content, generated_secrets = render_compose(app_id, params, instance_id, instance_num)
    except Exception as e:
        log.exception("Error rendering compose for %s: %s", app_id, e)
        return {"ok": False, "error": f"Erro ao compilar template da stack: {e}"}

    # 3. Detect and ensure external volumes
    for vol_match in re.finditer(r"^\s*([a-zA-Z0-9_\-\.]+):\s*$", yaml_content, re.MULTILINE):
        vol_name = vol_match.group(1)
        if vol_name not in ("services", "volumes", "networks", "configs", "secrets", "version"):
            _ensure_docker_volume(vol_name)

    # 4. Deploy stack via Portainer API
    log.info("Deploying stack '%s' to Portainer Swarm...", instance_id)
    p_res = portainer_client.create_swarm_stack(instance_id, yaml_content)
    if not p_res.get("ok"):
        # Fallback: deploy straight through the Docker CLI with the rendered YAML
        yaml_path = Path(f"/root/{instance_id}.yaml")
        yaml_path.write_text(yaml_content, encoding="utf-8")
        r = subprocess.run(
            ["docker", "stack", "deploy", "--prune", "--resolve-image", "always", "-c", str(yaml_path), instance_id],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            return {
                "ok": False,
                "error": f"Falha no deploy Portainer: {p_res.get('error')}",
                "details": p_res.get("details") or r.stderr[:500],
            }

    # 5. Save credentials in /root/dados_vps/dados_<instance_id> (SetupOrion format)
    try:
        DADOS_VPS.mkdir(parents=True, exist_ok=True)
        cred_file = DADOS_VPS / f"dados_{instance_id}"
        lines = [
            f"[ {app['name'].upper()} ]",
            "",
            f"Dominio: https://{domain}" if domain else "Dominio: (interno)",
            "",
            f"Instancia: {instance_id}",
            f"Data Instalacao: {datetime.now(timezone.utc).isoformat()}",
            "",
            "--- Credenciais e Chaves Geradas ---",
        ]
        for k, v in generated_secrets.items():
            if k not in ("network", "instance_id"):
                lines.append(f"{k}: {v}")

        cred_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception as e:
        log.warning("Could not save credentials file: %s", e)

    # 6. Register instance in SetupImpa registry
    registry.register(
        app_id,
        instance_id,
        instance_num,
        stack_name=instance_id,
        domain=domain,
        credentials=generated_secrets,
        params={"source": "setuporion"},
    )

    # 7. Post-install validation
    val = validate.wait_stack(instance_id, retries=4, delay=15)

    return {
        "ok": True,
        "instance_id": instance_id,
        "app": app_id,
        "domain": domain,
        "url": f"https://{domain}" if domain else "",
        "source": "setuporion",
        "validation": val,
        "credentials": generated_secrets,
    }
