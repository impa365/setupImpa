"""Post-install validation — stacks present + replicas 1/1 + Host health."""
from __future__ import annotations

import subprocess
import time
from typing import Any

from . import checks


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as e:
        return e.output or ""
    except Exception as e:
        return str(e)


def list_stacks() -> list[str]:
    out = _run(["docker", "stack", "ls", "--format", "{{.Name}}"])
    return [l.strip() for l in out.splitlines() if l.strip()]


def list_services(stack: str | None = None) -> list[dict[str, str]]:
    out = _run(["docker", "service", "ls", "--format", "{{.Name}}|{{.Replicas}}|{{.Image}}"])
    services = []
    for line in out.splitlines():
        parts = line.strip().split("|")
        if len(parts) < 2:
            continue
        name, replicas = parts[0], parts[1]
        image = parts[2] if len(parts) > 2 else ""
        if stack and not name.startswith(f"{stack}_"):
            continue
        services.append({"name": name, "replicas": replicas, "image": image})
    return services


def replicas_ok(replicas: str) -> bool:
    # 1/1 ok; 0/0 ignored; 0/1 bad
    if "/" not in replicas:
        return False
    a, b = replicas.split("/", 1)
    try:
        return int(a) >= 1 and int(a) == int(b)
    except ValueError:
        return False


def wait_stack(stack: str, expected_services: list[str] | None = None, retries: int = 6, delay: int = 15) -> dict[str, Any]:
    missing_stack = True
    bad: list[dict[str, str]] = []
    services: list[dict[str, str]] = []

    for attempt in range(1, retries + 1):
        stacks = list_stacks()
        missing_stack = stack not in stacks
        services = list_services(stack)
        bad = [s for s in services if not replicas_ok(s["replicas"])]
        if expected_services:
            names = {s["name"] for s in services}
            missing_svcs = [f"{stack}_{n}" if not n.startswith(stack) else n for n in expected_services if f"{stack}_{n}" not in names and n not in names]
        else:
            missing_svcs = []

        if not missing_stack and not bad and not missing_svcs:
            return {
                "ok": True,
                "stack": stack,
                "attempt": attempt,
                "services": services,
                "bad_services": [],
                "missing_services": [],
            }
        if attempt < retries:
            time.sleep(delay)

    return {
        "ok": False,
        "stack": stack,
        "attempt": retries,
        "stack_present": not missing_stack,
        "services": services,
        "bad_services": bad,
        "missing_services": missing_svcs if expected_services else [],
    }


def validate_app(stack: str, domain: str | None = None, expected_services: list[str] | None = None) -> dict[str, Any]:
    result = wait_stack(stack, expected_services=expected_services)
    dns = None
    health = None
    if domain:
        dns = checks.check_dns(domain)
        health = checks.traefik_host_health(domain)
    return {
        **result,
        "dns": dns,
        "traefik_health": health,
        "overall_ok": bool(result.get("ok")) and (dns is None or dns.get("match") or dns.get("cloudflare")),
    }
