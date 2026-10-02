"""SetupImpa MCP Prompts — Specialized DevOps and SysAdmin instructions."""
from __future__ import annotations

from typing import Any

PROMPTS_METADATA = [
    {
        "name": "diagnose_vps_health",
        "description": "Executa uma auditoria completa na VPS: avalia uso de CPU, RAM, espaco em disco, integridade do Docker Swarm, atualizacoes pendentes e emite recomendacoes operacionais.",
        "arguments": [],
    },
    {
        "name": "guide_app_deployment",
        "description": "Auxilia o usuario a escolher e instalar um aplicativo com seguranca (validando dominio, banco de dados e gerando credenciais).",
        "arguments": [
            {
                "name": "app_name",
                "description": "Nome ou ID da aplicacao desejada (ex: evolution, n8n, chatwoot, dify)",
                "required": False,
            }
        ],
    },
    {
        "name": "troubleshoot_container",
        "description": "Diagnostica problemas em uma aplicacao que nao esta respondendo, lendo os logs recentes e verificando o roteador Traefik e DNS.",
        "arguments": [
            {
                "name": "container_or_domain",
                "description": "Nome da aplicacao, container ou dominio com falha",
                "required": True,
            }
        ],
    },
]


def get_prompt(name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    args = arguments or {}
    if name == "diagnose_vps_health":
        return {
            "description": "Auditoria de Saude do Servidor VPS",
            "messages": [
                {
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": (
                            "Por favor, use a ferramenta 'vps_get_system_health' e 'vps_check_updates' para "
                            "fazer uma auditoria completa na minha VPS. Analise a porcentagem de RAM livre, "
                            "o espaco em disco, o status do Docker Swarm e se ha servicos com falha ou "
                            "atualizacoes pendentes. Apresente um resumo claro e me diga se o servidor precisa "
                            "de alguma acao imediata."
                        ),
                    },
                }
            ],
        }
    elif name == "guide_app_deployment":
        app = args.get("app_name", "a aplicacao")
        return {
            "description": "Guia de Instalacao de Aplicacao",
            "messages": [
                {
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": (
                            f"Quero instalar {app} no meu servidor. Primeiro verifique se os recursos da VPS "
                            "sao suficientes com 'vps_get_system_health', depois consulte os detalhes com "
                            f"'apps_catalog_get_details' para {app}. Verifique se o dominio que eu escolher "
                            "esta livre com 'dns_check_domain' e me guie em cada passo da instalacao."
                        ),
                    },
                }
            ],
        }
    elif name == "troubleshoot_container":
        target = args.get("container_or_domain", "")
        return {
            "description": "Diagnostico de Falhas de Aplicacao",
            "messages": [
                {
                    "role": "user",
                    "content": {
                        "type": "text",
                        "text": (
                            f"Estou com problemas na aplicacao ou container '{target}'. Por favor, leia os ultimos logs "
                            f"usando 'vps_get_container_logs' para '{target}', verifique o status dos servicos e me "
                            "explique a causa do erro e como podemos resolver (por exemplo, reiniciando o servico com "
                            "'vps_restart_service' ou ajustando a configuracao)."
                        ),
                    },
                }
            ],
        }

    return {"error": f"Prompt desconhecido: {name}"}
