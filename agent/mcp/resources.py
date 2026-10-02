"""SetupImpa MCP Resources — Dynamic read-only resources."""
from __future__ import annotations

import json
from typing import Any

from mcp import tools

RESOURCES_METADATA = [
    {
        "uri": "setupimpa://vps/health",
        "name": "VPS Real-time Health Snapshot",
        "description": "Estado atual de CPU, RAM, Disco, Docker Swarm e Servicos da VPS.",
        "mimeType": "application/json",
    },
    {
        "uri": "setupimpa://catalog/summary",
        "name": "Catalogo de Aplicacoes Disponiveis (+105 apps)",
        "description": "Lista resumida de todas as ferramentas disponiveis para instalacao no SetupImpa.",
        "mimeType": "application/json",
    },
    {
        "uri": "setupimpa://instances/running",
        "name": "Instancias e Stacks Instaladas",
        "description": "Lista de todas as aplicacoes ativas na VPS com suas respectivas URLs e dominios.",
        "mimeType": "application/json",
    },
]


def read_resource(uri: str) -> dict[str, Any]:
    uri = uri.strip()
    if uri == "setupimpa://vps/health":
        data = tools.vps_get_system_health()
        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": json.dumps(data, indent=2, ensure_ascii=False),
                }
            ]
        }
    elif uri == "setupimpa://catalog/summary":
        data = tools.apps_catalog_list()
        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": json.dumps(data, indent=2, ensure_ascii=False),
                }
            ]
        }
    elif uri == "setupimpa://instances/running":
        data = tools.apps_list_instances()
        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": json.dumps(data, indent=2, ensure_ascii=False),
                }
            ]
        }
    return {"error": f"Recurso desconhecido: {uri}"}
