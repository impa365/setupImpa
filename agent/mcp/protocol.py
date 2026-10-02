"""SetupImpa MCP Protocol Engine — JSON-RPC 2.0 implementation following MCP 2024-11-05 spec."""
from __future__ import annotations

import json
import logging
from typing import Any

from mcp import prompts, resources, tools

log = logging.getLogger("setupimpa.mcp.protocol")

SERVER_NAME = "SetupImpa VPS Agent"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"


def process_jsonrpc_request(req: dict[str, Any]) -> dict[str, Any] | None:
    """Process incoming MCP JSON-RPC 2.0 message and return response dict or None for notifications."""
    if not isinstance(req, dict):
        return {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32600, "message": "Invalid Request: expected object"},
        }

    msg_id = req.get("id")
    method = req.get("method")
    params = req.get("params", {}) or {}

    # Notification handling (methods starting with notifications/ or with no id)
    if method == "notifications/initialized":
        log.info("MCP client initialized notification received")
        return None

    if not method:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32600, "message": "Method missing"},
        }

    # 1. initialize
    if method == "initialize":
        client_info = params.get("clientInfo", {})
        log.info("MCP client connected: %s", client_info)
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": SERVER_VERSION,
                },
                "capabilities": {
                    "tools": {
                        "listChanged": False,
                    },
                    "resources": {
                        "subscribe": False,
                        "listChanged": False,
                    },
                    "prompts": {
                        "listChanged": False,
                    },
                    "logging": {},
                },
                "instructions": (
                    "SetupImpa e o instalador e gerenciador oficial de VPS da IMPA 365. "
                    "Voce tem acesso a ferramentas de infraestrutura para verificar CPU, RAM e Disco da VPS, "
                    "listar containers e logs, verificar atualizacoes do sistema, consultar o catalogo "
                    "de mais de 105 ferramentas (Evolution API, Chatwoot, N8N, Dify, Supabase, MinIO, etc.), "
                    "instalar e remover aplicacoes com 1 comando e configurar apontamentos DNS na Cloudflare."
                ),
            },
        }

    # 2. ping
    elif method == "ping":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {},
        }

    # 3. tools/list
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "tools": tools.TOOLS_METADATA,
            },
        }

    # 4. tools/call
    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if not tool_name:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32602, "message": "Tool name required"},
            }

        res = tools.execute_tool(tool_name, arguments)
        is_error = bool(res.get("error") and not res.get("ok", True))
        text_content = json.dumps(res, indent=2, ensure_ascii=False)

        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": text_content,
                    }
                ],
                "isError": is_error,
            },
        }

    # 5. resources/list
    elif method == "resources/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "resources": resources.RESOURCES_METADATA,
            },
        }

    # 6. resources/read
    elif method == "resources/read":
        uri = params.get("uri", "")
        res_data = resources.read_resource(uri)
        if "error" in res_data:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32602, "message": res_data["error"]},
            }
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": res_data,
        }

    # 7. prompts/list
    elif method == "prompts/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "prompts": prompts.PROMPTS_METADATA,
            },
        }

    # 8. prompts/get
    elif method == "prompts/get":
        prompt_name = params.get("name", "")
        prompt_args = params.get("arguments", {})
        p_res = prompts.get_prompt(prompt_name, prompt_args)
        if "error" in p_res:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32602, "message": p_res["error"]},
            }
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": p_res,
        }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }
