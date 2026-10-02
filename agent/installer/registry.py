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
        return {"instances": {}, "counters": {}}
    try:
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"instances": {}, "counters": {}}


def _save(data: dict[str, Any]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


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
