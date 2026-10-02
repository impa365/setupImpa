"""SetupImpa MCP Stdio Server & CLI Proxy.

Usage (In-process on VPS):
    python -m mcp.cli

Usage (Remote client connecting to VPS):
    python -m mcp.cli --url http://VPS_IP:8877 --token SEU_TOKEN
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def run_in_process():
    """Run MCP server in-process reading stdin/stdout."""
    from mcp import protocol

    # Force unbuffered UTF-8 stdout
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stdin.reconfigure(encoding="utf-8")

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()
            continue

        resp = protocol.process_jsonrpc_request(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def run_remote_proxy(url: str, token: str):
    """Proxy local stdio MCP to remote SetupImpa HTTP JSON-RPC endpoint."""
    import urllib.request

    url = url.rstrip("/")
    target = f"{url}/mcp/rpc"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "SetupImpa-MCP-CLI/1.0",
    }

    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stdin.reconfigure(encoding="utf-8")

    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req_data = line.encode("utf-8")
            req = urllib.request.Request(target, data=req_data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read().decode("utf-8")
                sys.stdout.write(data + "\n")
                sys.stdout.flush()
        except Exception as e:
            err = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": f"Proxy error: {e}"}}
            sys.stdout.write(json.dumps(err) + "\n")
            sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="SetupImpa MCP Server")
    parser.add_argument("--url", help="Remote SetupImpa Agent URL (e.g. http://74.1.21.235:8877)")
    parser.add_argument("--token", help="SetupImpa MCP API Key or Session Token")
    args = parser.parse_args()

    if args.url:
        run_remote_proxy(args.url, args.token or "")
    else:
        run_in_process()


if __name__ == "__main__":
    main()
