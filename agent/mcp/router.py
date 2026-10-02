"""FastAPI router for SetupImpa MCP (SSE Transport + Stateless JSON-RPC)."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from mcp import auth, protocol, tools

log = logging.getLogger("setupimpa.mcp.router")

mcp_router = APIRouter(tags=["mcp"])

# In-memory SSE active sessions: session_id -> asyncio.Queue[str]
SSE_SESSIONS: dict[str, asyncio.Queue[str]] = {}


def _check_auth(
    authorization: str | None = None,
    x_setupimpa_token: str | None = None,
    token_param: str | None = None,
) -> dict[str, Any]:
    token = token_param or authorization or x_setupimpa_token or ""
    auth_info = auth.validate_mcp_token(token)
    if not auth_info:
        raise HTTPException(
            status_code=401,
            detail="nao_autorizado: forneca um token valido via Bearer ou query param 'token'",
        )
    return auth_info


# ── Metadata & Status ───────────────────────────────────────────────

@mcp_router.get("/mcp/info")
def mcp_info():
    """Public info about the SetupImpa MCP server capabilities."""
    return {
        "ok": True,
        "name": protocol.SERVER_NAME,
        "version": protocol.SERVER_VERSION,
        "protocol": protocol.PROTOCOL_VERSION,
        "status": "online",
        "tools_count": len(tools.TOOLS_METADATA),
        "transports": ["sse", "http-jsonrpc"],
        "endpoints": {
            "sse": "/mcp/sse",
            "messages": "/mcp/messages",
            "rpc": "/mcp/rpc",
        },
    }


# ── Config & Key Management (for SetupImpa Web UI) ──────────────────

@mcp_router.get("/api/mcp/config")
def get_mcp_config(
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
):
    """Retrieve full MCP configuration and 1-click configs for Cursor, Claude, and Hermes."""
    _check_auth(authorization, x_setupimpa_token)
    key = auth.get_or_create_mcp_key()
    pub_ip = ""
    try:
        from installer import checks
        pub_ip = checks.public_ip()
    except Exception:
        pass

    base_url = f"http://{pub_ip}:8877" if pub_ip else "http://SEU_IP_VPS:8877"
    sse_url = f"{base_url}/mcp/sse?token={key}"

    # Sample configs
    cursor_config = {
        "mcpServers": {
            "setupimpa-vps": {
                "url": sse_url,
            }
        }
    }

    claude_desktop_config = {
        "mcpServers": {
            "setupimpa-vps": {
                "url": sse_url,
            }
        }
    }

    hermes_config = {
        "name": "SetupImpa VPS Controller",
        "type": "sse",
        "url": sse_url,
        "token": key,
    }

    return {
        "ok": True,
        "mcp_api_key": key,
        "server_name": protocol.SERVER_NAME,
        "public_ip": pub_ip,
        "base_url": base_url,
        "sse_url": sse_url,
        "tools_count": len(tools.TOOLS_METADATA),
        "configs": {
            "cursor": cursor_config,
            "claude_desktop": claude_desktop_config,
            "hermes": hermes_config,
        },
    }


@mcp_router.post("/api/mcp/key/regenerate")
def regenerate_key(
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
):
    """Regenerate the persistent MCP API Key."""
    _check_auth(authorization, x_setupimpa_token)
    new_key = auth.regenerate_mcp_key()
    return {"ok": True, "mcp_api_key": new_key}


# ── MCP Official SSE Transport ──────────────────────────────────────

@mcp_router.get("/mcp/sse")
async def mcp_sse(
    request: Request,
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
):
    """MCP Server-Sent Events stream entrypoint."""
    _check_auth(authorization, x_setupimpa_token, token)
    session_id = str(uuid.uuid4())
    queue: asyncio.Queue[str] = asyncio.Queue()
    SSE_SESSIONS[session_id] = queue

    # Pass the client token forward in the message endpoint so POST /mcp/messages is seamless
    token_str = token or auth.get_or_create_mcp_key()
    endpoint_data = f"/mcp/messages?session_id={session_id}&token={token_str}"

    async def event_generator():
        # First event per MCP spec: tell client where to POST messages
        yield f"event: endpoint\r\ndata: {endpoint_data}\r\n\r\n"

        try:
            while True:
                # Wait for messages or ping keepalive every 15s
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"event: message\r\ndata: {msg}\r\n\r\n"
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    # Keep-alive comment per SSE spec
                    yield ": ping\r\n\r\n"
        except asyncio.CancelledError:
            pass
        finally:
            SSE_SESSIONS.pop(session_id, None)
            log.info("MCP SSE session closed: %s", session_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@mcp_router.post("/mcp/messages")
async def mcp_messages(
    request: Request,
    session_id: str = Query(...),
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
):
    """Receive JSON-RPC messages from an active SSE session."""
    _check_auth(authorization, x_setupimpa_token, token)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, detail="JSON invalido")

    resp = protocol.process_jsonrpc_request(body)
    queue = SSE_SESSIONS.get(session_id)

    if resp is not None:
        raw_resp = json.dumps(resp, ensure_ascii=False)
        if queue:
            await queue.put(raw_resp)
        return JSONResponse(content=resp, status_code=200)

    # Notification acknowledged
    return JSONResponse(content={"ok": True}, status_code=202)


# ── Stateless Direct JSON-RPC Endpoint ──────────────────────────────

@mcp_router.post("/mcp/rpc")
@mcp_router.post("/mcp")
async def mcp_stateless_rpc(
    request: Request,
    authorization: str | None = Header(default=None),
    x_setupimpa_token: str | None = Header(default=None),
    token: str | None = Query(default=None),
):
    """Direct stateless JSON-RPC 2.0 endpoint for simple clients without SSE."""
    _check_auth(authorization, x_setupimpa_token, token)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, detail="JSON invalido")

    resp = protocol.process_jsonrpc_request(body)
    if resp is None:
        return JSONResponse(content={"ok": True}, status_code=200)
    return JSONResponse(content=resp, status_code=200)
