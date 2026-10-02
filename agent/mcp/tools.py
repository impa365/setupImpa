"""SetupImpa MCP Tools — High-performance DevOps and SysAdmin capabilities for AI agents."""
from __future__ import annotations

import json
import logging
import os
import platform
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from installer import checks, cloudflare, orion_engine, portainer_client, registry
from installer.apps import evolution, getfy, hermes, ninerouter, omniroute, postgres

log = logging.getLogger("setupimpa.mcp.tools")

DADOS = Path("/root/dados_vps")

APPS_MAP = {
    "postgres": postgres,
    "evolution": evolution,
    "hermes": hermes,
    "getfy": getfy,
    "omniroute": omniroute,
    "9router": ninerouter,
}

# ── Helper: System Metrics ──────────────────────────────────────────

def _get_cpu_and_mem() -> dict[str, Any]:
    """Parse /proc/stat and /proc/meminfo for lightweight zero-dependency metrics."""
    cpu_cores = os.cpu_count() or 1
    load1, load5, load15 = (0.0, 0.0, 0.0)
    try:
        load1, load5, load15 = os.getloadavg()
    except Exception:
        pass

    mem_total_mb = 0
    mem_free_mb = 0
    mem_avail_mb = 0
    meminfo_path = Path("/proc/meminfo")
    if meminfo_path.exists():
        try:
            for line in meminfo_path.read_text(encoding="utf-8").splitlines():
                parts = line.split(":")
                if len(parts) == 2:
                    k, v = parts[0].strip(), parts[1].strip().split()[0]
                    if k == "MemTotal":
                        mem_total_mb = int(v) // 1024
                    elif k == "MemFree":
                        mem_free_mb = int(v) // 1024
                    elif k == "MemAvailable":
                        mem_avail_mb = int(v) // 1024
        except Exception:
            pass

    if mem_total_mb > 0:
        mem_used_mb = mem_total_mb - (mem_avail_mb or mem_free_mb)
        mem_pct = round((mem_used_mb / mem_total_mb) * 100, 1)
    else:
        mem_used_mb = 0
        mem_pct = 0.0

    return {
        "cpu_cores": cpu_cores,
        "load_average": {"1m": round(load1, 2), "5m": round(load5, 2), "15m": round(load15, 2)},
        "memory_total_mb": mem_total_mb,
        "memory_used_mb": mem_used_mb,
        "memory_free_mb": mem_avail_mb or mem_free_mb,
        "memory_used_pct": mem_pct,
    }


def _get_uptime_str() -> str:
    uptime_path = Path("/proc/uptime")
    if uptime_path.exists():
        try:
            secs = float(uptime_path.read_text().split()[0])
            days = int(secs // 86400)
            hours = int((secs % 86400) // 3600)
            mins = int((secs % 3600) // 60)
            if days > 0:
                return f"{days}d {hours}h {mins}m"
            return f"{hours}h {mins}m"
        except Exception:
            pass
    return "unknown"


# ── 1. vps_get_system_health ────────────────────────────────────────

def vps_get_system_health() -> dict[str, Any]:
    """Retrieve full real-time diagnostics of the VPS: CPU, RAM, Disk, Swarm, and Core Services."""
    metrics = _get_cpu_and_mem()
    disk = shutil.disk_usage("/")
    disk_total_gb = round(disk.total / (1024**3), 1)
    disk_used_gb = round(disk.used / (1024**3), 1)
    disk_free_gb = round(disk.free / (1024**3), 1)
    disk_pct = round((disk.used / disk.total) * 100, 1) if disk.total else 0.0

    pub_ip = checks.public_ip()
    swarm_active = checks.swarm_active()
    traefik_ok = checks.stack_exists("traefik")
    portainer_ok = checks.stack_exists("portainer")

    instances = registry.list_all()
    status_summary = "SAUDAVEL"
    warnings = []

    if metrics["memory_used_pct"] > 88:
        status_summary = "ALERTA_MEMORIA_ALTA"
        warnings.append(f"RAM crítica: {metrics['memory_used_pct']}% utilizada ({metrics['memory_used_mb']}/{metrics['memory_total_mb']} MB)")
    if disk_pct > 85:
        status_summary = "ALERTA_DISCO_CHEIO"
        warnings.append(f"Disco crítico: {disk_pct}% utilizado ({disk_used_gb}/{disk_total_gb} GB)")
    if not swarm_active:
        status_summary = "SWARM_INATIVO"
        warnings.append("Docker Swarm não está ativo no host.")
    if not (traefik_ok and portainer_ok):
        status_summary = "BASE_PENDENTE"
        warnings.append("Infraestrutura base (Traefik + Portainer) não está totalmente ativa.")

    return {
        "status": status_summary,
        "public_ip": pub_ip,
        "os": platform.platform(),
        "arch": platform.machine(),
        "uptime": _get_uptime_str(),
        "cpu": {
            "cores": metrics["cpu_cores"],
            "load_1m": metrics["load_average"]["1m"],
            "load_5m": metrics["load_average"]["5m"],
            "load_15m": metrics["load_average"]["15m"],
        },
        "memory": {
            "total_mb": metrics["memory_total_mb"],
            "used_mb": metrics["memory_used_mb"],
            "free_mb": metrics["memory_free_mb"],
            "used_pct": metrics["memory_used_pct"],
        },
        "disk": {
            "total_gb": disk_total_gb,
            "used_gb": disk_used_gb,
            "free_gb": disk_free_gb,
            "used_pct": disk_pct,
        },
        "docker_swarm": {
            "active": swarm_active,
            "traefik_active": traefik_ok,
            "portainer_active": portainer_ok,
        },
        "instances_count": len(instances),
        "warnings": warnings,
    }


# ── 2. vps_check_updates ────────────────────────────────────────────

def vps_check_updates() -> dict[str, Any]:
    """Check if the VPS has pending OS package updates or Docker container restart issues."""
    pending_updates_count = 0
    security_updates_count = 0
    update_details = []

    # Check Ubuntu/Debian update-notifier file if present
    notifier_file = Path("/var/lib/update-notifier/updates-available")
    if notifier_file.exists():
        try:
            content = notifier_file.read_text(encoding="utf-8")
            m = re.search(r"(\d+)\s+updates?\s+can\s+be\s+applied", content)
            if m:
                pending_updates_count = int(m.group(1))
            ms = re.search(r"(\d+)\s+updates?\s+(?:are\s+security|can\s+be\s+installed\s+immediately)", content)
            if ms:
                security_updates_count = int(ms.group(1))
            update_details.append(content.strip())
        except Exception:
            pass

    # Inspect Swarm services for tasks with non-running state
    unhealthy_services = []
    try:
        import docker
        client = docker.DockerClient(base_url="unix://var/run/docker.sock")
        for s in client.services.list():
            s_name = s.name
            tasks = s.tasks(filters={"desired-state": "running"})
            running_tasks = [t for t in tasks if t.get("Status", {}).get("State") == "running"]
            if not running_tasks and tasks:
                last_err = tasks[0].get("Status", {}).get("Err", "Nao iniciado")
                unhealthy_services.append({"service": s_name, "error": last_err})
    except Exception:
        pass

    recommendations = []
    if security_updates_count > 0:
        recommendations.append(f"Execute 'apt-get update && apt-get upgrade -y' para aplicar {security_updates_count} atualizacoes de seguranca.")
    if unhealthy_services:
        recommendations.append(f"Existem {len(unhealthy_services)} servicos com tarefas com falha. Verifique os logs com 'vps_get_container_logs'.")
    if not recommendations:
        recommendations.append("Servidor e containers atualizados e saudaveis. Nenhuma acao urgente necessaria.")

    return {
        "pending_os_updates": pending_updates_count,
        "security_updates": security_updates_count,
        "unhealthy_services": unhealthy_services,
        "recommendations": recommendations,
    }


# ── 3. vps_list_containers ──────────────────────────────────────────

def vps_list_containers() -> dict[str, Any]:
    """List all Docker containers currently running or present on the host."""
    containers = []
    try:
        import docker
        client = docker.DockerClient(base_url="unix://var/run/docker.sock")
        for c in client.containers.list(all=True):
            containers.append({
                "id": c.short_id,
                "name": c.name,
                "image": c.image.tags[0] if c.image.tags else str(c.image.id)[:12],
                "status": c.status,
                "created": c.attrs.get("Created", "")[:19],
            })
    except Exception as e:
        # Fallback to docker ps subprocess
        try:
            out = subprocess.check_output(
                ["docker", "ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"],
                text=True, timeout=10
            )
            for line in out.splitlines():
                if "\t" in line:
                    cid, name, img, st = line.split("\t", 3)
                    containers.append({"id": cid, "name": name, "image": img, "status": st})
        except Exception as e2:
            return {"ok": False, "error": f"Docker API error: {e} / {e2}"}

    return {"ok": True, "total": len(containers), "containers": containers}


# ── 4. vps_get_container_logs ───────────────────────────────────────

def vps_get_container_logs(container_name: str, tail: int = 100, timestamps: bool = False) -> dict[str, Any]:
    """Fetch recent stdout/stderr logs from a specific container for troubleshooting."""
    container_name = container_name.strip()
    if not container_name:
        return {"ok": False, "error": "container_name obrigatorio"}
    tail = max(10, min(tail, 1000))

    try:
        import docker
        client = docker.DockerClient(base_url="unix://var/run/docker.sock")
        # Try finding container exact or partial
        target = None
        for c in client.containers.list(all=True):
            if c.name == container_name or container_name in c.name or c.short_id == container_name:
                target = c
                break
        if not target:
            return {"ok": False, "error": f"Container '{container_name}' nao encontrado"}

        raw_logs = target.logs(tail=tail, timestamps=timestamps)
        log_text = raw_logs.decode("utf-8", errors="replace")
        return {
            "ok": True,
            "container": target.name,
            "status": target.status,
            "tail_lines": tail,
            "logs": log_text,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── 5. vps_docker_prune ─────────────────────────────────────────────

def vps_docker_prune(prune_all_images: bool = False) -> dict[str, Any]:
    """Safely reclaim disk space by purging dangling images, build cache, and stopped containers."""
    try:
        import docker
        client = docker.DockerClient(base_url="unix://var/run/docker.sock")
        c_res = client.containers.prune()
        i_res = client.images.prune(filters={"dangling": not prune_all_images})
        b_res = client.builds.prune() if hasattr(client, "builds") else {}

        freed_bytes = (
            (c_res.get("SpaceReclaimed") or 0) +
            (i_res.get("SpaceReclaimed") or 0) +
            (b_res.get("SpaceReclaimed") or 0)
        )
        freed_mb = round(freed_bytes / (1024**2), 2)
        return {
            "ok": True,
            "freed_mb": freed_mb,
            "containers_deleted": len(c_res.get("ContainersDeleted") or []),
            "images_deleted": len(i_res.get("ImagesDeleted") or []),
            "message": f"Limpeza concluida com sucesso. {freed_mb} MB liberados no disco.",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── 6. vps_restart_service ──────────────────────────────────────────

def vps_restart_service(target: str) -> dict[str, Any]:
    """Gracefully restart a Docker Swarm service or container without losing persisted data."""
    target = target.strip()
    if not target:
        return {"ok": False, "error": "target obrigatorio (ex: traefik, evolution, n8n)"}

    # 1. Try Docker Swarm service update --force
    try:
        r = subprocess.run(
            ["docker", "service", "update", "--force", target],
            capture_output=True, text=True, timeout=40
        )
        if r.returncode == 0:
            return {"ok": True, "target": target, "type": "swarm_service", "message": f"Servico Swarm '{target}' reiniciado com sucesso."}
    except Exception:
        pass

    # 2. Try docker restart container
    try:
        r = subprocess.run(
            ["docker", "restart", target],
            capture_output=True, text=True, timeout=30
        )
        if r.returncode == 0:
            return {"ok": True, "target": target, "type": "container", "message": f"Container '{target}' reiniciado com sucesso."}
        return {"ok": False, "error": r.stderr or "Falha ao reiniciar"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── 7. apps_catalog_list ────────────────────────────────────────────

def apps_catalog_list(category: str | None = None, search: str | None = None) -> dict[str, Any]:
    """Query and filter the full 105+ application catalog (Official IMPA + SetupOrion)."""
    base_ok = checks.stack_exists("traefik") and checks.stack_exists("portainer")
    items = []
    known_ids = set()

    # 1. Official IMPA Apps
    for app_id, mod in APPS_MAP.items():
        m = mod.meta()
        aid = m["id"]
        known_ids.add(aid)
        instances = registry.list_by_app(aid)
        items.append({
            "id": aid,
            "name": m.get("name", aid),
            "description": m.get("description", ""),
            "category": m.get("category", "outros"),
            "source": "official",
            "ram_required": m.get("ram_required", "1 GB RAM"),
            "requires_domain": m.get("requires_domain", True),
            "instances_installed": len(instances),
        })

    # 2. Orion 100+ Stacks
    for o_app in orion_engine.list_apps():
        o_id = o_app["id"]
        if o_id in known_ids or o_id == "base":
            continue
        known_ids.add(o_id)
        instances = registry.list_by_app(o_id)
        items.append({
            "id": o_id,
            "name": o_app.get("name", o_id),
            "description": o_app.get("description", ""),
            "category": o_app.get("category", "outros"),
            "source": "setuporion",
            "ram_required": "1 GB RAM",
            "requires_domain": True,
            "instances_installed": len(instances),
        })

    # Filtering
    if category and category.lower() != "all":
        c = category.lower().strip()
        items = [i for i in items if c in i["category"].lower() or (c == "ai" and i["category"] in ("ia", "ai"))]

    if search:
        q = search.lower().strip()
        items = [
            i for i in items
            if q in i["id"].lower() or q in i["name"].lower() or q in i["description"].lower() or q in i["category"].lower()
        ]

    return {
        "ok": True,
        "base_ready": base_ok,
        "total_available": len(items),
        "apps": items,
    }


# ── 8. apps_catalog_get_details ─────────────────────────────────────

def apps_catalog_get_details(app_id: str) -> dict[str, Any]:
    """Get full technical specification for an app, including parameters, database needs, and fields."""
    app_id = app_id.strip()
    is_official = app_id in APPS_MAP
    orion_app = orion_engine.get_app(app_id)

    if not is_official and not orion_app:
        return {"ok": False, "error": f"App '{app_id}' nao encontrado no catalogo"}

    if is_official:
        meta = APPS_MAP[app_id].meta()
        fields = meta.get("fields", [])
        return {
            "ok": True,
            "id": app_id,
            "name": meta.get("name", app_id),
            "description": meta.get("description", ""),
            "source": "official",
            "category": meta.get("category", "outros"),
            "requires_domain": meta.get("requires_domain", True),
            "ram_required": meta.get("ram_required", "1 GB RAM"),
            "fields": fields,
            "multi_instance": True,
            "instances_running": len(registry.list_by_app(app_id)),
        }

    # Orion App
    fields = orion_engine.get_ui_fields(app_id)
    return {
        "ok": True,
        "id": app_id,
        "name": orion_app.get("name", app_id),
        "description": orion_app.get("description", ""),
        "source": "setuporion",
        "category": orion_app.get("category", "outros"),
        "requires_domain": True,
        "ram_required": "1 GB RAM",
        "pg_dbs": orion_app.get("pg_dbs", []),
        "fields": fields,
        "multi_instance": True,
        "instances_running": len(registry.list_by_app(app_id)),
    }


# ── 9. apps_list_instances ──────────────────────────────────────────

def apps_list_instances(app_id: str | None = None) -> dict[str, Any]:
    """List all deployed application instances on this VPS."""
    all_inst = registry.list_all()
    if app_id:
        all_inst = [i for i in all_inst if i.get("app") == app_id.strip()]

    # Enrich with active Docker stack status
    enriched = []
    for inst in all_inst:
        s_name = inst.get("stack_name", inst.get("instance_id", ""))
        is_active = checks.stack_exists(s_name)
        domain = inst.get("domain", "")
        url = f"https://{domain}" if domain else ""
        enriched.append({
            "instance_id": inst.get("instance_id"),
            "app": inst.get("app"),
            "instance_num": inst.get("instance_num", 1),
            "stack_name": s_name,
            "stack_active": is_active,
            "domain": domain,
            "url": url,
            "created_at": inst.get("created_at"),
            "has_credentials": bool(inst.get("credentials")),
        })

    return {
        "ok": True,
        "total": len(enriched),
        "instances": enriched,
    }


# ── 10. apps_get_instance_credentials ───────────────────────────────

def apps_get_instance_credentials(instance_id: str) -> dict[str, Any]:
    """Securely retrieve credentials (passwords, API tokens, database strings) for an instance."""
    instance_id = instance_id.strip()
    inst = registry.get(instance_id)

    if inst and inst.get("credentials"):
        return {
            "ok": True,
            "instance_id": instance_id,
            "app": inst.get("app", instance_id),
            "domain": inst.get("domain", ""),
            "credentials": inst.get("credentials", {}),
        }

    # Fallback to /root/dados_vps/dados_<id>
    fname = f"dados_{instance_id}"
    path = DADOS / fname
    if not path.exists():
        if instance_id in ("base", "portainer"):
            path = DADOS / "dados_portainer"
    if path.exists():
        content = path.read_text(encoding="utf-8", errors="replace")
        creds = {}
        for line in content.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                creds[k.strip()] = v.strip()
        return {
            "ok": True,
            "instance_id": instance_id,
            "app": instance_id,
            "credentials": creds,
            "raw_text": content,
        }

    return {"ok": False, "error": f"Nenhuma credencial encontrada para a instancia '{instance_id}'"}


# ── 11. apps_install ────────────────────────────────────────────────

def apps_install(
    app_id: str,
    domain: str | None = None,
    params: dict[str, Any] | None = None,
    auto_cloudflare_dns: bool = True,
) -> dict[str, Any]:
    """Deploy any tool (Evolution API, Chatwoot, N8N, Dify, Supabase, Postgres) onto this VPS."""
    app_id = app_id.strip()
    params = dict(params or {})

    if domain:
        norm_domain = checks.normalize_domain(domain)
        params["domain"] = norm_domain

        # Collision check
        for inst in registry.list_all():
            if checks.normalize_domain(inst.get("domain", "")) == norm_domain:
                return {
                    "ok": False,
                    "error": f"O dominio '{norm_domain}' ja esta em uso pela instancia '{inst.get('instance_id')}'",
                }

        # Auto Cloudflare DNS if requested and token configured
        if auto_cloudflare_dns and cloudflare.has_token():
            try:
                cloudflare.ensure_dns_for_domain(domain=norm_domain, proxied=False)
                log.info("DNS Cloudflare criado automaticamente para %s", norm_domain)
            except Exception as e:
                log.warning("Falha ao criar DNS Cloudflare automatico: %s", e)

    # Next instance ID
    instance_id, instance_num = registry.next_instance_id(app_id)
    params["instance_id"] = instance_id
    params["instance_num"] = instance_num

    # Run installation
    is_official = app_id in APPS_MAP
    if is_official:
        install_fn = APPS_MAP[app_id].install
        result = install_fn(**params)
    else:
        result = orion_engine.install(app_id=app_id, **params)

    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or result}

    # Fetch created credentials
    creds = apps_get_instance_credentials(instance_id)

    return {
        "ok": True,
        "instance_id": instance_id,
        "instance_num": instance_num,
        "app_id": app_id,
        "domain": params.get("domain", ""),
        "url": f"https://{params.get('domain')}" if params.get("domain") else "",
        "credentials": creds.get("credentials", {}),
        "message": f"Instalacao de {app_id} (instancia: {instance_id}) concluida com sucesso!",
    }


# ── 12. apps_remove_instance ────────────────────────────────────────

def apps_remove_instance(instance_id: str, confirm: bool = False) -> dict[str, Any]:
    """Cleanly uninstall and delete an application instance and its Docker Swarm stack."""
    if not confirm:
        return {
            "ok": False,
            "error": "Confirmacao obrigatoria. Passe confirm=True para autorizar a remocao.",
        }
    instance_id = instance_id.strip()
    inst = registry.get(instance_id)
    if not inst:
        return {"ok": False, "error": f"Instancia '{instance_id}' nao encontrada no registro"}

    stack_name = inst.get("stack_name", instance_id)
    rm_res = registry.remove_stack(stack_name)
    registry.unregister(instance_id)

    # Remove dados file
    dados_file = DADOS / f"dados_{instance_id}"
    if dados_file.exists():
        try:
            dados_file.unlink()
        except Exception:
            pass

    return {
        "ok": True,
        "instance_id": instance_id,
        "stack_removed": stack_name,
        "details": rm_res,
        "message": f"Instancia '{instance_id}' e stack '{stack_name}' removidas com sucesso.",
    }


# ── 13. dns_check_domain ────────────────────────────────────────────

def dns_check_domain(domain: str) -> dict[str, Any]:
    """Test if a domain properly resolves to this VPS and verify Traefik SSL readiness."""
    return checks.check_dns(domain)


# ── 14. dns_cloudflare_setup ────────────────────────────────────────

def dns_cloudflare_setup(domain: str, proxied: bool = False) -> dict[str, Any]:
    """Create or update a DNS A record on Cloudflare pointing directly to this VPS."""
    if not cloudflare.has_token():
        return {
            "ok": False,
            "error": "Token da Cloudflare nao configurado no SetupImpa.",
            "hint": "Configure o token na aba Cloudflare DNS do painel SetupImpa.",
        }
    res = cloudflare.ensure_dns_for_domain(domain=domain, proxied=proxied)
    return res


# ── 15. dns_cloudflare_status ───────────────────────────────────────

def dns_cloudflare_status() -> dict[str, Any]:
    """Check if Cloudflare token is configured and valid on this VPS."""
    if not cloudflare.has_token():
        return {"configured": False, "ok": False, "message": "Nenhum token configurado"}
    token = cloudflare.get_token()
    verify = cloudflare.verify_token(token)
    return {**verify, "configured": True}


# ── 16. vps_execute_safe_command ────────────────────────────────────

SAFE_COMMANDS = {
    "uptime": ["uptime"],
    "df": ["df", "-h"],
    "free": ["free", "-h"],
    "docker_ps": ["docker", "ps"],
    "docker_stack_ls": ["docker", "stack", "ls"],
    "docker_service_ls": ["docker", "service", "ls"],
    "docker_node_ls": ["docker", "node", "ls"],
    "netstat_listen": ["ss", "-tuln"],
}

def vps_execute_safe_command(command: str) -> dict[str, Any]:
    """Run an authorized read-only system diagnostic command directly on the host."""
    cmd_key = command.strip().lower()
    if cmd_key not in SAFE_COMMANDS:
        return {
            "ok": False,
            "error": f"Comando '{command}' nao permitido.",
            "allowed_commands": list(SAFE_COMMANDS.keys()),
        }
    cmd_args = SAFE_COMMANDS[cmd_key]
    try:
        r = subprocess.run(cmd_args, capture_output=True, text=True, timeout=15)
        return {
            "ok": r.returncode == 0,
            "command": " ".join(cmd_args),
            "stdout": r.stdout,
            "stderr": r.stderr,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Tool Definitions for MCP Schema ─────────────────────────────────

TOOLS_METADATA = [
    {
        "name": "vps_get_system_health",
        "description": "Obtem diagnostico completo em tempo real da VPS: uso de CPU, RAM (total/usada/livre/%), Disco (total/usado/livre/% na raiz /), Uptime, IP Publico, status do Docker Swarm e status dos roteadores centrais Traefik e Portainer.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "vps_check_updates",
        "description": "Verifica se a VPS possui atualizacoes pendentes de pacotes de seguranca do sistema operacional (Debian/Ubuntu) e se ha servicos Docker com falhas ou reinicios inesperados.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "vps_list_containers",
        "description": "Lista todos os containers Docker presentes no host (em execucao ou parados), com ID, nome, imagem, status e data de criacao.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "vps_get_container_logs",
        "description": "Le os ultimos logs de stdout/stderr de um container especifico para diagnosticar erros de inicializacao, falhas de conexao ou status de servicos.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "container_name": {
                    "type": "string",
                    "description": "Nome ou ID do container (ex: evolution, traefik_traefik.1, chatwoot_chatwoot.1, etc.)",
                },
                "tail": {
                    "type": "integer",
                    "description": "Numero de linhas finais a recuperar (padrao 100, maximo 1000)",
                    "default": 100,
                },
                "timestamps": {
                    "type": "boolean",
                    "description": "Se verdadeiro, inclui data e hora em cada linha de log",
                    "default": False,
                },
            },
            "required": ["container_name"],
        },
    },
    {
        "name": "vps_docker_prune",
        "description": "Libera espaco em disco com seguranca no servidor purgando containers parados, imagens nao utilizadas (dangling) e cache de build do Docker sem afetar volumes de dados ativos.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prune_all_images": {
                    "type": "boolean",
                    "description": "Se verdadeiro, remove todas as imagens sem containers ativos; se falso, remove apenas imagens orfas (dangling). Padrao: false.",
                    "default": False,
                }
            },
            "required": [],
        },
    },
    {
        "name": "vps_restart_service",
        "description": "Reinicia graciosamente um servico do Docker Swarm ou container na VPS sem apagar volumes ou configuracoes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "Nome da stack ou servico a reiniciar (ex: traefik, evolution, n8n, chatwoot)",
                }
            },
            "required": ["target"],
        },
    },
    {
        "name": "apps_catalog_list",
        "description": "Consulta e filtra o catalogo de mais de 105 aplicacoes prontas para instalacao no SetupImpa (oficiais e catalogo completo SetupOrion).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Filtro opcional por categoria: 'all', 'ai' (ou 'ia'), 'whatsapp', 'banco', 'automacao', 'crm', 'infra', 'seguranca', 'desenvolvimento', 'marketing', 'utilitarios'",
                },
                "search": {
                    "type": "string",
                    "description": "Palavra-chave de busca (ex: 'n8n', 'chatwoot', 'bot', 'postgres', 's3', 'crm')",
                },
            },
            "required": [],
        },
    },
    {
        "name": "apps_catalog_get_details",
        "description": "Obtem os detalhes tecnicos completos de qualquer aplicacao: descricao, portas padrao, campos necessarios (ex: subdominio), requisitos de banco PostgreSQL e integracao SSL.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "app_id": {
                    "type": "string",
                    "description": "ID unico do aplicativo (ex: 'evolution', 'chatwoot', 'n8n', 'dify', 'minio', 'supabase', 'postgres', 'twentycrm')",
                }
            },
            "required": ["app_id"],
        },
    },
    {
        "name": "apps_list_instances",
        "description": "Lista todas as instancias de aplicacoes que ja estao instaladas e rodando nesta VPS, com seus respectivos dominios, URLs web e status no Docker Swarm.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "app_id": {
                    "type": "string",
                    "description": "Filtro opcional pelo ID do aplicativo (ex: 'evolution', 'postgres')",
                }
            },
            "required": [],
        },
    },
    {
        "name": "apps_get_instance_credentials",
        "description": "Recupera com seguranca as credenciais geradas de uma instancia instalada: senhas de administrador, tokens de API, URLs de conexao com banco de dados e chave mestra.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "instance_id": {
                    "type": "string",
                    "description": "Identificador da instancia (ex: 'evolution', 'postgres', 'n8n', 'chatwoot_2')",
                }
            },
            "required": ["instance_id"],
        },
    },
    {
        "name": "apps_install",
        "description": "Instala qualquer uma das mais de 105 aplicacoes na VPS com 1 comando. Gera banco de dados se necessario, configura certificado SSL automatico via Traefik e pode apontar o DNS na Cloudflare automaticamente.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "app_id": {
                    "type": "string",
                    "description": "ID do aplicativo a instalar (ex: 'evolution', 'chatwoot', 'n8n', 'dify', 'minio', 'postgres')",
                },
                "domain": {
                    "type": "string",
                    "description": "Subdominio ou dominio que acessara a aplicacao (ex: 'evo.meusite.com', 'chat.empresa.com.br')",
                },
                "params": {
                    "type": "object",
                    "description": "Parametros adicionais opcionais (ex: 'admin_email', 'admin_password', 'db_password')",
                },
                "auto_cloudflare_dns": {
                    "type": "boolean",
                    "description": "Se verdadeiro e o token Cloudflare estiver configurado, cria o apontamento DNS tipo A automaticamente.",
                    "default": True,
                },
            },
            "required": ["app_id"],
        },
    },
    {
        "name": "apps_remove_instance",
        "description": "Remove e desinstala completamente uma instancia da VPS: encerra o servico no Docker Swarm e limpa o registro de instancias.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "instance_id": {
                    "type": "string",
                    "description": "ID da instancia a ser removida (ex: 'evolution_2', 'chatwoot')",
                },
                "confirm": {
                    "type": "boolean",
                    "description": "Confirmacao obrigatoria de seguranca para evitar remocao acidental (deve ser True).",
                },
            },
            "required": ["instance_id", "confirm"],
        },
    },
    {
        "name": "dns_check_domain",
        "description": "Verifica se um dominio ou subdominio esta devidamente apontado para o IP publico desta VPS, se passa pelo proxy Cloudflare e se o Traefik SSL responde.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "domain": {
                    "type": "string",
                    "description": "Dominio ou subdominio a ser testado (ex: 'chat.meusite.com')",
                }
            },
            "required": ["domain"],
        },
    },
    {
        "name": "dns_cloudflare_setup",
        "description": "Cria ou atualiza automaticamente o registro DNS tipo A no Cloudflare apontando o dominio para o IP publico desta VPS.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "domain": {
                    "type": "string",
                    "description": "Dominio ou subdominio (ex: 'n8n.meusite.com')",
                },
                "proxied": {
                    "type": "boolean",
                    "description": "Se falso (recomendado para WebSockets de WhatsApp/Chat), aponta como DNS Only (nuvem cinza). Se verdadeiro, ativa proxy Cloudflare.",
                    "default": False,
                },
            },
            "required": ["domain"],
        },
    },
    {
        "name": "dns_cloudflare_status",
        "description": "Verifica se a integracao com a API da Cloudflare esta configurada e valida nesta VPS.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "vps_execute_safe_command",
        "description": "Executa um comando de diagnostico e inspecao somente-leitura na VPS (lista restrita autorizada: 'uptime', 'df', 'free', 'docker_ps', 'docker_stack_ls', 'docker_service_ls', 'docker_node_ls', 'netstat_listen').",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Comando seguro a executar",
                    "enum": [
                        "uptime",
                        "df",
                        "free",
                        "docker_ps",
                        "docker_stack_ls",
                        "docker_service_ls",
                        "docker_node_ls",
                        "netstat_listen",
                    ],
                }
            },
            "required": ["command"],
        },
    },
]


def execute_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Execute tool by name and return result dictionary."""
    args = arguments or {}

    dispatch = {
        "vps_get_system_health": lambda: vps_get_system_health(),
        "vps_check_updates": lambda: vps_check_updates(),
        "vps_list_containers": lambda: vps_list_containers(),
        "vps_get_container_logs": lambda: vps_get_container_logs(
            container_name=args.get("container_name", ""),
            tail=args.get("tail", 100),
            timestamps=args.get("timestamps", False),
        ),
        "vps_docker_prune": lambda: vps_docker_prune(
            prune_all_images=args.get("prune_all_images", False)
        ),
        "vps_restart_service": lambda: vps_restart_service(
            target=args.get("target", "")
        ),
        "apps_catalog_list": lambda: apps_catalog_list(
            category=args.get("category"),
            search=args.get("search"),
        ),
        "apps_catalog_get_details": lambda: apps_catalog_get_details(
            app_id=args.get("app_id", "")
        ),
        "apps_list_instances": lambda: apps_list_instances(
            app_id=args.get("app_id")
        ),
        "apps_get_instance_credentials": lambda: apps_get_instance_credentials(
            instance_id=args.get("instance_id", "")
        ),
        "apps_install": lambda: apps_install(
            app_id=args.get("app_id", ""),
            domain=args.get("domain"),
            params=args.get("params"),
            auto_cloudflare_dns=args.get("auto_cloudflare_dns", True),
        ),
        "apps_remove_instance": lambda: apps_remove_instance(
            instance_id=args.get("instance_id", ""),
            confirm=args.get("confirm", False),
        ),
        "dns_check_domain": lambda: dns_check_domain(
            domain=args.get("domain", "")
        ),
        "dns_cloudflare_setup": lambda: dns_cloudflare_setup(
            domain=args.get("domain", ""),
            proxied=args.get("proxied", False),
        ),
        "dns_cloudflare_status": lambda: dns_cloudflare_status(),
        "vps_execute_safe_command": lambda: vps_execute_safe_command(
            command=args.get("command", "")
        ),
    }

    fn = dispatch.get(name)
    if not fn:
        return {"error": f"Ferramenta desconhecida: {name}"}

    try:
        return fn()
    except Exception as e:
        log.exception("Erro ao executar ferramenta %s: %s", name, e)
        return {"error": f"Excecao na execucao de {name}: {str(e)}"}
