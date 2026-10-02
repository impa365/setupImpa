"""Portainer API client — real login validation + swarm stack create."""
from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import ssl

log = logging.getLogger("setupimpa.portainer")

DADOS = Path("/root/dados_vps/dados_portainer")
CTX = ssl._create_unverified_context()


def _read_dados() -> dict[str, str]:
    if not DADOS.exists():
        return {}
    out: dict[str, str] = {}
    for line in DADOS.read_text(encoding="utf-8", errors="replace").splitlines():
        if "Dominio do portainer:" in line:
            out["domain"] = line.split("Dominio do portainer:", 1)[1].strip()
        elif line.startswith("Url:"):
            out["url"] = line.split("Url:", 1)[1].strip()
        elif line.startswith("Usuario:"):
            out["user"] = line.split("Usuario:", 1)[1].strip()
        elif line.startswith("Senha:"):
            out["pass"] = line.split("Senha:", 1)[1].strip()
    if "domain" not in out and out.get("url"):
        out["domain"] = out["url"].replace("https://", "").replace("http://", "").strip("/")
    return out


def _bases(domain: str) -> list[str]:
    return [
        f"https://{domain}",
        "https://127.0.0.1",
        "http://127.0.0.1:9000",
    ]


def _request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    host: str | None = None,
    timeout: int = 20,
) -> tuple[int, str]:
    hdrs = dict(headers or {})
    if host:
        hdrs["Host"] = host
    req = Request(url, data=data, headers=hdrs, method=method)
    try:
        with urlopen(req, context=CTX, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except HTTPError as e:
        body = e.read().decode("utf-8", "replace") if e.fp else ""
        return e.code, body
    except Exception as e:
        return 0, str(e)


def login(user: str, password: str, domain: str | None = None) -> dict[str, Any]:
    dados = _read_dados()
    domain = domain or dados.get("domain") or ""
    user = user or dados.get("user") or ""
    password = password or dados.get("pass") or ""
    if not user or not password or not domain:
        return {"ok": False, "error": "credenciais_ausentes", "domain": domain}

    payload = json.dumps({"username": user, "password": password}).encode()
    for base in _bases(domain):
        host = domain if "127.0.0.1" in base else None
        code, body = _request(
            "POST",
            f"{base}/api/auth",
            headers={"Content-Type": "application/json"},
            data=payload,
            host=host,
        )
        if code == 200:
            try:
                jwt = json.loads(body).get("jwt")
            except Exception:
                jwt = None
            if jwt:
                return {"ok": True, "jwt": jwt, "base": base, "domain": domain, "user": user}
    return {"ok": False, "error": "auth_failed", "domain": domain}


def setup_timed_out(domain: str) -> bool:
    for base in _bases(domain):
        host = domain if "127.0.0.1" in base else None
        code, body = _request("GET", f"{base}/", host=host, timeout=8)
        if "timed out for security" in body.lower() or "timeout.html" in body.lower() or "re-enable your Portainer" in body.lower():
            return True
    return False


def restart_portainer() -> None:
    subprocess.run(["docker", "service", "update", "--force", "portainer_portainer"], check=False)
    time.sleep(8)


def _setup_token_from_logs() -> str:
    try:
        out = subprocess.check_output(
            ["docker", "service", "logs", "portainer_portainer"],
            text=True,
            stderr=subprocess.STDOUT,
        )
    except Exception:
        return ""
    import re
    matches = re.findall(r"setup_token=([a-f0-9]+)", out)
    return matches[-1] if matches else ""


def init_admin(user: str, password: str, domain: str, cycles: int = 3) -> dict[str, Any]:
    # Already exists?
    auth = login(user, password, domain)
    if auth.get("ok"):
        return {"ok": True, "status": "exists", **auth}

    if setup_timed_out(domain):
        restart_portainer()

    payload = json.dumps({"Username": user, "Password": password}).encode()

    for cycle in range(1, cycles + 1):
        for _ in range(12):
            if setup_timed_out(domain):
                restart_portainer()
            token = _setup_token_from_logs()
            for base in _bases(domain):
                host = domain if "127.0.0.1" in base else None
                # try auth first
                auth = login(user, password, domain)
                if auth.get("ok"):
                    return {"ok": True, "status": "exists", **auth}
                headers = {"Content-Type": "application/json"}
                if token:
                    headers["X-Setup-Token"] = token
                code, body = _request(
                    "POST",
                    f"{base}/api/users/admin/init",
                    headers=headers,
                    data=payload,
                    host=host,
                )
                if code in (200, 201) or '"Username"' in body:
                    auth = login(user, password, domain)
                    if auth.get("ok"):
                        return {"ok": True, "status": "created", **auth}
                if "already" in body.lower() or "exists" in body.lower() or "initialized" in body.lower():
                    auth = login(user, password, domain)
                    if auth.get("ok"):
                        return {"ok": True, "status": "exists", **auth}
                if "timed out" in body.lower() or "timeout" in body.lower() or "expired" in body.lower():
                    restart_portainer()
                    break
            time.sleep(5)
        log.warning("Portainer admin init cycle %s/%s failed — restarting", cycle, cycles)
        restart_portainer()

    return {"ok": False, "error": "init_timeout", "domain": domain}


def get_endpoint_and_swarm(jwt: str, base: str, domain: str) -> dict[str, Any]:
    host = domain if "127.0.0.1" in base else None
    headers = {"Authorization": f"Bearer {jwt}"}
    code, body = _request("GET", f"{base}/api/endpoints", headers=headers, host=host)
    if code != 200:
        return {"ok": False, "error": f"endpoints_{code}", "body": body[:300]}
    endpoints = json.loads(body)
    endpoint = next((e for e in endpoints if e.get("Name") == "primary"), endpoints[0] if endpoints else None)
    if not endpoint:
        return {"ok": False, "error": "no_endpoint"}
    eid = endpoint["Id"]
    code, body = _request("GET", f"{base}/api/endpoints/{eid}/docker/swarm", headers=headers, host=host)
    if code != 200:
        return {"ok": False, "error": f"swarm_{code}", "endpoint_id": eid}
    swarm_id = json.loads(body).get("ID")
    return {"ok": True, "endpoint_id": eid, "swarm_id": swarm_id, "base": base, "domain": domain, "jwt": jwt}


def create_swarm_stack(
    name: str,
    stack_file_content: str,
    *,
    user: str | None = None,
    password: str | None = None,
    domain: str | None = None,
) -> dict[str, Any]:
    auth = login(user or "", password or "", domain)
    if not auth.get("ok"):
        return {"ok": False, "error": "auth_failed", "detail": auth}

    meta = get_endpoint_and_swarm(auth["jwt"], auth["base"], auth["domain"])
    if not meta.get("ok"):
        return meta

    # Prefer multipart file create (SetupOrion style)
    import tempfile
    import httpx

    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8") as f:
        f.write(stack_file_content)
        tmp = f.name

    try:
        url = f"{meta['base']}/api/stacks/create/swarm/file"
        headers = {"Authorization": f"Bearer {meta['jwt']}"}
        if "127.0.0.1" in meta["base"]:
            headers["Host"] = meta["domain"]
        with httpx.Client(verify=False, timeout=60.0) as client:
            with open(tmp, "rb") as fh:
                files = {"file": (f"{name}.yaml", fh, "application/x-yaml")}
                data = {
                    "Name": name,
                    "endpointId": str(meta["endpoint_id"]),
                    "SwarmID": meta["swarm_id"],
                }
                resp = client.post(url, headers=headers, data=data, files=files)
            if resp.status_code in (200, 201):
                return {"ok": True, "status_code": resp.status_code, "name": name, "via": "create/swarm/file"}

            # Fallback: update if exists
            stacks = client.get(
                f"{meta['base']}/api/stacks",
                headers={**headers, "Content-Type": "application/json"},
            )
            if stacks.status_code == 200:
                for s in stacks.json():
                    if s.get("Name") == name:
                        sid = s["Id"]
                        put = client.put(
                            f"{meta['base']}/api/stacks/{sid}?endpointId={meta['endpoint_id']}",
                            headers={**headers, "Content-Type": "application/json"},
                            json={"stackFileContent": stack_file_content, "env": [], "prune": True},
                        )
                        if put.status_code in (200, 201):
                            return {"ok": True, "status_code": put.status_code, "name": name, "via": "update"}
                        return {"ok": False, "error": "update_failed", "body": put.text[:500]}
            return {"ok": False, "error": "create_failed", "status_code": resp.status_code, "body": resp.text[:500]}
    finally:
        Path(tmp).unlink(missing_ok=True)


def save_dados_portainer(domain: str, user: str, password: str) -> None:
    Path("/root/dados_vps").mkdir(parents=True, exist_ok=True)
    content = f"""========================================================================
                      DADOS DO PORTAINER
========================================================================
Dominio do portainer: {domain}
Url: https://{domain}
Usuario: {user}
Senha: {password}
========================================================================
"""
    DADOS.write_text(content, encoding="utf-8")
