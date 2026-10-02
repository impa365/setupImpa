"""Multi-instance registry — tracks every deployed instance per app.

File: /root/dados_vps/setupimpa_instances.json
Schema:
{
  "instances": {
    "<instance_id>": {
      "app": "evolution",
      "instance_id": "evolution",         # first = same as app
      "instance_num": 1,                  # human-friendly counter
      "stack_name": "evolution",           # docker stack name
      "domain": "evo.x.com",
      "created_at": "2026-...",
      "credentials": { ... },
      "params": { ... }                   # original install params
    }
  },
  "counters": {
    "evolution": 2                        # next = 3
  }
}
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("setupimpa.registry")

REGISTRY_PATH = Path("/root/dados_vps/setupimpa_instances.json")


def _load() -> dict[str, Any]:
    if not REGISTRY_PATH.exists():
        data = {"instances": {}, "counters": {}}
    else:
        try:
            data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        except Exception:
            data = {"instances": {}, "counters": {}}

    # Sincronização e compatibilidade automática com SetupOrion
    if sync_orion_instances(data):
        _save(data)

    return data


def sync_orion_instances(data: dict[str, Any]) -> bool:
    """Auto-detecta e importa dados/instâncias existentes do SetupOrion para o SetupImpa."""
    dados_dir = Path("/root/dados_vps")
    if not dados_dir.exists():
        return False

    changed = False
    instances = data.setdefault("instances", {})
    counters = data.setdefault("counters", {})

    for p in dados_dir.glob("dados_*"):
        fname = p.name
        if fname in ("dados_vps", "dados_portainer"):
            continue

        # Ex: dados_postgres, dados_postgres_2, dados_evolution, dados_evolution_2
        stem = fname.replace("dados_", "")
        parts = stem.split("_")

        if len(parts) > 1 and parts[-1].isdigit():
            app_id = "_".join(parts[:-1])
            num = int(parts[-1])
        else:
            app_id = stem
            num = 1

        instance_id = stem
        if instance_id in instances:
            continue

        # Lê conteúdo salvo pelo SetupOrion
        try:
            content = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        domain = ""
        creds: dict[str, str] = {}
        for line in content.splitlines():
            line = line.strip()
            if ":" in line:
                k, v = line.split(":", 1)
                k_clean = k.strip().lower()
                v_clean = v.strip()
                creds[k_clean] = v_clean
                if k_clean in ("baseurl", "dominio", "url", "painel", "dashboard") and not domain:
                    domain = v_clean.replace("https://", "").replace("http://", "").split("/")[0]

        instances[instance_id] = {
            "app": app_id,
            "instance_id": instance_id,
            "instance_num": num,
            "stack_name": instance_id,
            "domain": domain,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "credentials": creds,
            "params": {"imported_from": "setup_orion"},
        }
        counters[app_id] = max(counters.get(app_id, 0), num)
        changed = True
        log.info("Instância SetupOrion importada com sucesso: %s (app: %s, #%d)", instance_id, app_id, num)

    return changed


def _save(data: dict[str, Any]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def register_instance(
    app_id: str,
    instance_id: str,
    instance_num: int,
    *,
    domain: str = "",
    stack_name: str = "",
    stack_id: str | None = None,
    credentials: dict | None = None,
    extra: dict | None = None,
    params: dict | None = None,
) -> dict[str, Any]:
    """Helper compatível com omniroute e 9router."""
    creds = dict(credentials or {})
    if extra:
        creds.update(extra)
    return register(
        app_id,
        instance_id,
        instance_num,
        stack_name=stack_name or instance_id,
        domain=domain,
        credentials=creds,
        params=params or {},
    )


# ── public helpers ──────────────────────────────────────────────────

def next_instance_id(app_id: str) -> tuple[str, int]:
    """Return (instance_id, instance_num) for a new instance.
    First instance of an app → id == app_id, num == 1.
    Second → id == app_id_2, num == 2.  etc.
    """
    data = _load()
    counter = data.get("counters", {}).get(app_id, 0)
    num = counter + 1
    instance_id = app_id if num == 1 else f"{app_id}_{num}"
    return instance_id, num


def register(
    app_id: str,
    instance_id: str,
    instance_num: int,
    *,
    stack_name: str,
    domain: str = "",
    credentials: dict | None = None,
    params: dict | None = None,
) -> dict[str, Any]:
    data = _load()
    entry = {
        "app": app_id,
        "instance_id": instance_id,
        "instance_num": instance_num,
        "stack_name": stack_name,
        "domain": domain,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "credentials": credentials or {},
        "params": params or {},
    }
    data["instances"][instance_id] = entry
    data.setdefault("counters", {})[app_id] = max(
        data["counters"].get(app_id, 0), instance_num
    )
    _save(data)
    log.info("registered instance %s (app=%s, num=%d)", instance_id, app_id, instance_num)
    return entry


def unregister(instance_id: str) -> bool:
    data = _load()
    if instance_id not in data.get("instances", {}):
        return False
    del data["instances"][instance_id]
    _save(data)
    log.info("unregistered instance %s", instance_id)
    return True


def get(instance_id: str) -> dict[str, Any] | None:
    return _load().get("instances", {}).get(instance_id)


def list_by_app(app_id: str) -> list[dict[str, Any]]:
    data = _load()
    return sorted(
        [v for v in data.get("instances", {}).values() if v.get("app") == app_id],
        key=lambda x: x.get("instance_num", 0),
    )


def list_all() -> list[dict[str, Any]]:
    data = _load()
    return sorted(
        data.get("instances", {}).values(),
        key=lambda x: x.get("created_at", ""),
    )


def count_by_app(app_id: str) -> int:
    return len(list_by_app(app_id))


def instance_id_exists(instance_id: str) -> bool:
    return instance_id in _load().get("instances", {})


def remove_stack(stack_name: str) -> dict[str, Any]:
    """docker stack rm <stack>."""
    try:
        r = subprocess.run(
            ["docker", "stack", "rm", stack_name],
            capture_output=True, text=True, timeout=30,
        )
        return {"ok": r.returncode == 0, "stdout": r.stdout, "stderr": r.stderr}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def sanitize_id(raw: str) -> str:
    """Only lowercase alphanum + underscores."""
    return re.sub(r"[^a-z0-9_]", "_", raw.lower().strip())
