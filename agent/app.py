"""SetupImpa Agent — FastAPI panel backend (multi-instance)."""
from __future__ import annotations

import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from installer import auth, base, checks, cloudflare, orion_engine, portainer_client, registry, validate
from installer.apps import evolution, getfy, hermes, ninerouter, omniroute, postgres
from mcp import mcp_router

VERSION = os.environ.get("SETUPIMPA_VERSION", "0.3.0")
STATIC = Path(__file__).resolve().parent / "static"
DADOS = Path("/root/dados_vps")
LOG_FILE = Path("/var/log/setupimpa.log")

_handlers = [logging.StreamHandler()]
try:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    _handlers.append(logging.FileHandler(LOG_FILE))
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=_handlers,
)
log = logging.getLogger("setupimpa")

app = FastAPI(title="SetupImpa", version=VERSION)
app.include_router(mcp_router)
JOBS: dict[str, dict[str, Any]] = {}
APPS = {
    "postgres": postgres,
    "evolution": evolution,
    "hermes": hermes,
    "getfy": getfy,
    "omniroute": omniroute,
    "9router": ninerouter,
}


def _extract_bearer(
    authorization: str | None = None,
    x_setupimpa_token: str | None = None,
) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return (x_setupimpa_token or "").strip()


def require_auth(
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
):
    token = _extract_bearer(authorization, x_setupimpa_token)
    sess = auth.validate_session(token)
    if not sess:
        raise HTTPException(status_code=401, detail="nao_autenticado")
    return sess


class SetupBody(BaseModel):
    username: str
    password: str


class LoginBody(BaseModel):
    username: str
    password: str


class AcceptBody(BaseModel):
    accepted: bool = True


class BaseInstallBody(BaseModel):
    email: str
    portainer_domain: str
    user: str = "admin"
    password: str = ""


class FinishBaseBody(BaseModel):
    confirm_cloudflare: bool = False


class DnsBody(BaseModel):
    domain: str


class CloudflareTokenBody(BaseModel):
    token: str


class CloudflareDnsBody(BaseModel):
    domain: str
    ip: str | None = None
    proxied: bool = False


class InstallAppBody(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)


class RemoveInstanceBody(BaseModel):
    instance_id: str


# ── Auth endpoints ──────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION, "name": "SetupImpa"}


@app.get("/api/auth/status")
def auth_status(
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
):
    token = _extract_bearer(authorization, x_setupimpa_token)
    st = auth.status(token)
    return {**st, "version": VERSION}


@app.post("/api/auth/setup")
def auth_setup(body: SetupBody):
    result = auth.create_admin(body.username, body.password)
    if not result.get("ok"):
        raise HTTPException(400, detail=result.get("error", "setup_failed"))
    login = auth.login(body.username, body.password)
    if not login.get("ok"):
        raise HTTPException(500, detail="setup_ok_login_failed")
    return login


@app.post("/api/auth/login")
def auth_login(body: LoginBody):
    result = auth.login(body.username, body.password)
    if not result.get("ok"):
        raise HTTPException(401, detail=result.get("error", "login_failed"))
    return result


@app.post("/api/auth/logout")
def auth_logout(
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
):
    token = _extract_bearer(authorization, x_setupimpa_token)
    auth.logout(token)
    return {"ok": True}


# ── Status / preflight ─────────────────────────────────────────────

@app.get("/api/status")
def status(_: dict = Depends(require_auth)):
    pf = checks.run_preflight()
    return {
        "version": VERSION,
        "public_ip": pf.get("public_ip"),
        "base_installed": pf.get("base_installed"),
        "accepted_risk": pf.get("accepted_risk"),
        "preflight": pf,
    }


@app.post("/api/preflight")
def preflight(_: dict = Depends(require_auth)):
    return checks.run_preflight()


@app.post("/api/accept")
def accept(body: AcceptBody, _: dict = Depends(require_auth)):
    DADOS.mkdir(parents=True, exist_ok=True)
    if body.accepted:
        (DADOS / "setupimpa_accepted").write_text("yes\n", encoding="utf-8")
    return {"ok": True, "accepted_risk": True}


# ── Base install ────────────────────────────────────────────────────

@app.post("/api/install/base")
def install_base(body: BaseInstallBody, _: dict = Depends(require_auth)):
    if not (DADOS / "setupimpa_accepted").exists():
        raise HTTPException(400, detail="aceite_risco_pendente")
    return base.install_base(
        email=body.email,
        portainer_domain=body.portainer_domain,
        user=body.user,
        password=body.password,
    )


@app.post("/api/install/base/finish")
def finish_base(body: FinishBaseBody, _: dict = Depends(require_auth)):
    return base.finish_base_after_dns(confirm_cloudflare=body.confirm_cloudflare)


@app.get("/api/base/info")
def base_info(_: dict = Depends(require_auth)):
    dados = portainer_client._read_dados()
    domain = dados.get("domain", "")
    url = dados.get("url", f"https://{domain}" if domain else "")
    return {
        "ok": bool(dados),
        "configured": bool(domain),
        "domain": domain,
        "url": url,
        "user": dados.get("user", "admin"),
        "password": dados.get("pass", ""),
    }


@app.post("/api/dns/check")
def dns_check(body: DnsBody, _: dict = Depends(require_auth)):
    return checks.check_dns(body.domain)


# ── Cloudflare DNS automation ─────────────────────────────────────

@app.get("/api/cloudflare/status")
def cf_status(_: dict = Depends(require_auth)):
    """Check if Cloudflare token is configured and valid."""
    if not cloudflare.has_token():
        return {"ok": False, "configured": False, "error": "token_nao_configurado"}
    token = cloudflare.get_token()
    verify = cloudflare.verify_token(token)
    return {**verify, "configured": True}


@app.post("/api/cloudflare/token")
def cf_save_token(body: CloudflareTokenBody, _: dict = Depends(require_auth)):
    """Save Cloudflare API token."""
    token = body.token.strip()
    if not token:
        raise HTTPException(400, detail="token_vazio")
    verify = cloudflare.verify_token(token)
    if not verify.get("ok"):
        raise HTTPException(400, detail=verify.get("error", "token_invalido"))
    cloudflare.save_token(token)
    return {"ok": True, "status": "active", "message": "Token Cloudflare salvo com sucesso."}


@app.post("/api/cloudflare/dns")
def cf_create_dns(body: CloudflareDnsBody, _: dict = Depends(require_auth)):
    """Create or update DNS A record via Cloudflare API."""
    if not cloudflare.has_token():
        raise HTTPException(400, detail="cloudflare_token_nao_configurado")
    result = cloudflare.ensure_dns_for_domain(
        domain=body.domain,
        ip=body.ip,
        proxied=body.proxied,
    )
    if not result.get("ok"):
        raise HTTPException(400, detail=result)
    return result


@app.delete("/api/cloudflare/dns/{domain}")
def cf_delete_dns(domain: str, _: dict = Depends(require_auth)):
    """Delete a DNS A record via Cloudflare API."""
    if not cloudflare.has_token():
        raise HTTPException(400, detail="cloudflare_token_nao_configurado")
    token = cloudflare.get_token()
    result = cloudflare.delete_dns_record(domain, token)
    if not result.get("ok"):
        raise HTTPException(400, detail=result)
    return result


@app.post("/api/cloudflare/zone")
def cf_find_zone(body: DnsBody, _: dict = Depends(require_auth)):
    """Find Cloudflare zone for a domain."""
    if not cloudflare.has_token():
        raise HTTPException(400, detail="cloudflare_token_nao_configurado")
    token = cloudflare.get_token()
    return cloudflare.find_zone(body.domain, token)


# ── App catalog (multi-instance) ───────────────────────────────────

@app.get("/api/apps")
def list_apps(_: dict = Depends(require_auth)):
    base_ok = checks.stack_exists("traefik") and checks.stack_exists("portainer")
    pg_instances = postgres.get_available_instances()
    items = []
    known_ids = set()

    # 1. Apps Oficiais SetupImpa
    for app_id, mod in APPS.items():
        m = mod.meta()
        aid = m["id"]
        known_ids.add(aid)
        instances = registry.list_by_app(aid)
        items.append({
            **m,
            "source": "official",
            "instance_count": len(instances),
            "instances": instances,
            "blocked": m.get("requires_base") and not base_ok,
        })

    # 2. Catálogo Completo SetupOrion (100+ Stacks Swarm adaptadas)
    for o_app in orion_engine.list_apps():
        o_id = o_app["id"]
        if o_id in known_ids or o_id == "base":
            continue
        known_ids.add(o_id)
        instances = registry.list_by_app(o_id)
        fields = orion_engine.get_ui_fields(o_id)
        items.append({
            "id": o_id,
            "name": o_app["name"],
            "description": o_app["description"],
            "category": o_app.get("category", "outros"),
            "source": "setuporion",
            "requires_base": True,
            "requires_domain": True,
            "multi_instance": True,
            "instance_count": len(instances),
            "instances": instances,
            "blocked": not base_ok,
            "fields": fields,
            "pg_dbs": o_app.get("pg_dbs", []),
        })

    # 3. Detecta e agrega instâncias importadas do SetupOrion (ex: dados_*)
    for inst in registry.list_all():
        aid = inst.get("app", "")
        if aid and aid not in known_ids and aid != "base":
            inst_list = registry.list_by_app(aid)
            items.append({
                "id": aid,
                "name": inst.get("app", aid).title(),
                "description": f"Instância gerenciada/importada do SetupOrion ({inst.get('instance_id')})",
                "category": "outros",
                "source": "setuporion",
                "instance_count": len(inst_list),
                "instances": inst_list,
                "multi_instance": True,
                "blocked": False,
                "fields": [],
            })
            known_ids.add(aid)

    # 4. Item de Infraestrutura Base
    items.insert(0, {
        "id": "base",
        "name": "Traefik + Portainer",
        "description": "Infra base IMPA-hardened (obrigatorio)",
        "source": "official",
        "category": "infra",
        "requires_base": False,
        "requires_domain": True,
        "multi_instance": False,
        "installed": base_ok,
        "instance_count": 1 if base_ok else 0,
        "instances": [],
        "blocked": False,
        "fields": [],
    })
    return {
        "apps": items,
        "base_installed": base_ok,
        "postgres_instances": pg_instances,
    }


# ── Install app (creates new instance) ─────────────────────────────

def _run_job(job_id: str, fn, kwargs: dict):
    JOBS[job_id]["status"] = "running"
    try:
        result = fn(**kwargs)
        JOBS[job_id]["status"] = "done" if result.get("ok") else "error"
        JOBS[job_id]["result"] = result
    except Exception as e:
        log.exception("job %s failed", job_id)
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["result"] = {"ok": False, "error": str(e)}


def domain_already_used(domain: str) -> str | None:
    """Check if a domain is already used by any registered instance. Returns instance_id or None."""
    if not domain:
        return None
    domain = checks.normalize_domain(domain)
    for inst in registry.list_all():
        if checks.normalize_domain(inst.get("domain", "")) == domain:
            return inst.get("instance_id")
    return None


@app.post("/api/install/{app_id}")
def install_app(app_id: str, body: InstallAppBody, _: dict = Depends(require_auth)):
    is_official = app_id in APPS
    is_orion = bool(orion_engine.get_app(app_id))
    if not is_official and not is_orion:
        raise HTTPException(404, detail="app_desconhecido")
    if not (checks.stack_exists("traefik") and checks.stack_exists("portainer")):
        raise HTTPException(400, detail="base_obrigatoria")

    # ── Anti-substitution: check domain collision ──
    domain = body.params.get("domain", "")
    if domain:
        existing = domain_already_used(domain)
        if existing:
            raise HTTPException(
                409,
                detail={
                    "error": "dominio_em_uso",
                    "message": f"O domínio '{domain}' já está em uso pela instância '{existing}'. Use um domínio diferente ou remova a instância existente primeiro.",
                    "existing_instance": existing,
                },
            )

    # Resolve instance_id and instance_num
    instance_id, instance_num = registry.next_instance_id(app_id)

    # ── Anti-substitution: check stack collision ──
    if checks.stack_exists(instance_id):
        raise HTTPException(
            409,
            detail={
                "error": "stack_existente",
                "message": f"Já existe uma stack Docker '{instance_id}' rodando. Remova-a primeiro pelo painel ou use 'docker stack rm {instance_id}'.",
                "existing_stack": instance_id,
            },
        )

    params = {**body.params, "instance_id": instance_id, "instance_num": instance_num}

    job_id = str(uuid.uuid4())
    JOBS[job_id] = {"id": job_id, "app": app_id, "instance_id": instance_id, "status": "queued", "result": None}

    if is_official:
        install_fn = APPS[app_id].install
    else:
        install_fn = lambda **kw: orion_engine.install(app_id=app_id, **kw)

    t = threading.Thread(target=_run_job, args=(job_id, install_fn, params), daemon=True)
    t.start()
    return {"ok": True, "job_id": job_id, "instance_id": instance_id, "instance_num": instance_num}


@app.get("/api/install/{job_id}")
def job_status(job_id: str, _: dict = Depends(require_auth)):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, detail="job_nao_encontrado")
    return job


# ── Instance management ────────────────────────────────────────────

@app.get("/api/instances")
def list_instances(_: dict = Depends(require_auth)):
    return {"ok": True, "instances": registry.list_all()}


@app.get("/api/instances/{app_id}")
def list_app_instances(app_id: str, _: dict = Depends(require_auth)):
    return {"ok": True, "app": app_id, "instances": registry.list_by_app(app_id)}


@app.get("/api/instance/{instance_id}")
def get_instance(instance_id: str, _: dict = Depends(require_auth)):
    inst = registry.get(instance_id)
    if not inst:
        raise HTTPException(404, detail="instancia_nao_encontrada")
    return {"ok": True, **inst}


@app.delete("/api/instance/{instance_id}")
def remove_instance(instance_id: str, _: dict = Depends(require_auth)):
    inst = registry.get(instance_id)
    if not inst:
        raise HTTPException(404, detail="instancia_nao_encontrada")
    stack_name = inst.get("stack_name", instance_id)
    rm = registry.remove_stack(stack_name)
    registry.unregister(instance_id)
    # Remove dados file
    dados_file = DADOS / f"dados_{instance_id}"
    if dados_file.exists():
        dados_file.unlink()
    return {"ok": True, "instance_id": instance_id, "stack_removed": rm}


# ── Validate / credentials ─────────────────────────────────────────

@app.get("/api/validate/{app_id}")
def validate_app(app_id: str, domain: str | None = None, _: dict = Depends(require_auth)):
    return validate.validate_app(app_id, domain=domain)


@app.get("/api/credentials/{instance_id}")
def credentials(instance_id: str, _: dict = Depends(require_auth)):
    # Try registry first
    inst = registry.get(instance_id)
    if inst and inst.get("credentials"):
        return {"ok": True, "app": inst.get("app", instance_id), "instance_id": instance_id, "content": _format_creds(inst)}

    # Legacy fallback: dados files
    mapping = {
        "base": "dados_portainer",
        "portainer": "dados_portainer",
    }
    fname = mapping.get(instance_id, f"dados_{instance_id}")
    path = DADOS / fname
    if not path.exists():
        raise HTTPException(404, detail="credenciais_nao_encontradas")
    return {"ok": True, "app": instance_id, "content": path.read_text(encoding="utf-8", errors="replace")}


def _format_creds(inst: dict) -> str:
    creds = inst.get("credentials", {})
    lines = [f"[ {inst.get('app', '').upper()} — {inst.get('instance_id', '')} ]", ""]
    for k, v in creds.items():
        lines.append(f"{k}: {v}")
    lines.append(f"\nStack: {inst.get('stack_name', '')}")
    lines.append(f"Instancia: #{inst.get('instance_num', '')}")
    return "\n".join(lines)


# ── Static SPA ──────────────────────────────────────────────────────

if (STATIC / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC / "assets")), name="assets")


@app.get("/")
def index():
    index_path = STATIC / "index.html"
    if index_path.exists():
        return FileResponse(index_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return {"message": "SetupImpa agent online", "version": VERSION}


@app.post("/api/system/update")
def system_update(auth: str = Depends(require_auth)):
    """Baixa o pacote oficial mais recente e atualiza o painel instantaneamente."""
    try:
        import urllib.request, tarfile, io
        url = os.environ.get("SETUPIMPA_TARBALL_URL", "https://setup.impa365.com/setupimpa.tar.gz")
        req = urllib.request.Request(url, headers={"User-Agent": "SetupImpa-SelfUpdate"})
        data = urllib.request.urlopen(req, timeout=30).read()
        buf = io.BytesIO(data)
        install_dir = Path("/opt/setupimpa")
        with tarfile.open(fileobj=buf, mode="r:gz") as tar:
            tar.extractall(path=install_dir)
        return {"ok": True, "message": "Painel atualizado com sucesso! Recarregue a página."}
    except Exception as e:
        log.error("Update failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
