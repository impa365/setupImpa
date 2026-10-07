#!/usr/bin/env bash
# SetupImpa — Instalador automático de painel para VPS (IMPA 365)
# Uso: bash install.sh   ou   bash <(curl -sSL https://setup.impa365.com)
set -euo pipefail

SETUPIMPA_VERSION="0.2.0"
SETUPIMPA_BASE_URL="${SETUPIMPA_BASE_URL:-https://setup.impa365.com}"
SETUPIMPA_TARBALL_URL="${SETUPIMPA_TARBALL_URL:-${SETUPIMPA_BASE_URL}/setupimpa.tar.gz}"
SETUPIMPA_TELEMETRY_URL="${SETUPIMPA_TELEMETRY_URL:-${SETUPIMPA_BASE_URL}/telemetry}"
SETUPIMPA_RUN_ID=""

AGENT_PORT="${SETUPIMPA_PORT:-8877}"
INSTALL_DIR="/opt/setupimpa"
DADOS_DIR="/root/dados_vps"
LOG_FILE="/var/log/setupimpa.log"
NETWORK_NAME="${SETUPIMPA_NETWORK:-network_public}"

# Cores e estilos modernos
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
BOLD='\033[1m'
RESET='\033[0m'

# Log apenas para arquivo (evita duplicar na tela)
log() {
  echo "[$(date -Iseconds 2>/dev/null || date)] $*" >> "$LOG_FILE" 2>/dev/null || true
}

ok() {
  echo -e "    ${GREEN}✔${RESET} ${WHITE}$1${RESET}"
  log "OK: $1"
}

die() {
  impa_telemetry "failed" || true
  echo ""
  echo -e "  ${RED}✖ ERRO:${RESET} ${WHITE}$1${RESET}"
  echo -e "  ${GRAY}Detalhes salvos em: $LOG_FILE${RESET}"
  echo ""
  log "FATAL: $1"
  exit 1
}

info() {
  echo -e "    ${CYAN}➜${RESET} ${GRAY}$1${RESET}"
  log "INFO: $1"
}

step() {
  echo ""
  echo -e "  ${CYAN}[$1]${RESET} ${BOLD}${WHITE}$2${RESET}"
  log "STEP: $1 - $2"
}

impa_telemetry_init() {
  SETUPIMPA_RUN_ID="$(date +%s 2>/dev/null || echo 0)-$$"
}

impa_telemetry() {
  local step="$1"
  command -v curl >/dev/null 2>&1 || return 0
  local payload
  payload=$(printf '{"step":"%s","version":"%s","run":"%s"}' \
    "$step" "$SETUPIMPA_VERSION" "${SETUPIMPA_RUN_ID:-}")
  ( curl -fsS -m 4 -X POST "$SETUPIMPA_TELEMETRY_URL" \
      -A "SetupImpa/${SETUPIMPA_VERSION}" \
      -H "Content-Type: application/json" \
      -d "$payload" >/dev/null 2>&1 & ) || true
}

banner() {
  clear 2>/dev/null || true
  echo ""
  echo -e "  ${CYAN}┌──────────────────────────────────────────────────────────────┐${RESET}"
  echo -e "  ${CYAN}│${RESET}                                                              ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}   ${BOLD}${WHITE}🚀 SETUPIMPA${RESET}  ${CYAN}v${SETUPIMPA_VERSION}${RESET}                                           ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}   ${GRAY}Instalador Automático para Servidores VPS${RESET}                  ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}   ${CYAN}https://setup.impa365.com${RESET}  ·  ${WHITE}IMPA 365${RESET}                          ${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}                                                              ${CYAN}│${RESET}"
  echo -e "  ${CYAN}└──────────────────────────────────────────────────────────────┘${RESET}"
}

require_root() {
  if [ "$(id -u 2>/dev/null || echo 1)" -ne 0 ]; then
    die "Você precisa executar este comando como root. Use: sudo bash <(curl -sSL https://setup.impa365.com)"
  fi
}

validate_os() {
  if [ ! -f /etc/os-release ]; then
    die "Sistema operacional não reconhecido. Use Ubuntu 20.04+ ou Debian 11–13."
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian)
      case "${VERSION_ID:-}" in
        11|12|13) ok "Sistema: Debian $VERSION_ID" ;;
        *) die "Versão do Debian ($VERSION_ID) não suportada. Recomendamos Debian 11 ou 12." ;;
      esac
      ;;
    ubuntu)
      case "${VERSION_ID:-}" in
        20.04|22.04|23.04|23.10|24.04|24.10|25.04) ok "Sistema: Ubuntu $VERSION_ID" ;;
        *) die "Versão do Ubuntu ($VERSION_ID) antiga. Recomendamos Ubuntu 22.04 ou 24.04." ;;
      esac
      ;;
    *) die "Sistema não homologado (${ID:-desconhecido}). Este instalador roda em Ubuntu ou Debian." ;;
  esac
  ARCH=$(uname -m 2>/dev/null || echo "x86_64")
  ok "Arquitetura: $ARCH"
}

check_disk() {
  local free needed
  free=$(df -B1 / 2>/dev/null | awk 'NR==2{print $4}')
  needed=$((5 * 1024 * 1024 * 1024))
  if [ -n "$free" ] && [ "$free" -lt "$needed" ] 2>/dev/null; then
    die "Espaço livre em disco muito baixo (mínimo recomendado: 5 GB)."
  fi
  ok "Espaço em disco suficiente"
}

ensure_deps() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq curl jq openssl ca-certificates dnsutils >/dev/null 2>&1 || \
    apt-get install -y curl jq openssl ca-certificates >/dev/null 2>&1 || true
  ok "Dependências básicas instaladas"
}

detect_setuporion() {
  if [ -f "$DADOS_DIR/dados_vps" ]; then
    local orion_net
    orion_net=$(grep "Rede interna:" "$DADOS_DIR/dados_vps" 2>/dev/null | awk -F': ' '{print $2}' | tr -d '\r\n ' || true)
    if [ -n "$orion_net" ]; then
      NETWORK_NAME="$orion_net"
      ok "Compatibilidade SetupOrion: Rede interna detectada e preservada (${CYAN}$NETWORK_NAME${RESET})"
    fi
  fi
}

ensure_docker() {
  detect_setuporion
  if command -v docker >/dev/null 2>&1; then
    ok "Docker já está instalado e pronto"
  else
    info "Instalando Docker (aguarde alguns instantes)..."
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "Falha ao instalar o Docker automaticamente."
    systemctl enable --now docker >/dev/null 2>&1 || true
    ok "Docker instalado com sucesso"
  fi

  if docker info 2>/dev/null | grep -q 'Swarm: active'; then
    ok "Docker Swarm ativo"
  else
    info "Ativando modo cluster do Docker..."
    docker swarm init --advertise-addr "$(hostname -I 2>/dev/null | awk '{print $1}')" >/dev/null 2>&1 \
      || docker swarm init >/dev/null 2>&1 || true
    ok "Docker Swarm inicializado"
  fi

  if docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx "$NETWORK_NAME"; then
    ok "Rede segura de comunicação interna ativa"
  else
    docker network create --driver overlay --attachable "$NETWORK_NAME" >/dev/null 2>&1 || true
    ok "Rede segura interna criada"
  fi
}

generate_token() {
  mkdir -p "$DADOS_DIR"
  if [ -f "$DADOS_DIR/setupimpa_token" ]; then
    SETUPIMPA_TOKEN=$(cat "$DADOS_DIR/setupimpa_token")
  else
    SETUPIMPA_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "$SETUPIMPA_TOKEN" > "$DADOS_DIR/setupimpa_token"
    chmod 600 "$DADOS_DIR/setupimpa_token" 2>/dev/null || true
  fi
  ok "Chave de segurança do painel gerada"
}

install_agent_files() {
  mkdir -p "$INSTALL_DIR"
  # Bind-mount source for Traefik's file provider. Swarm rejects the Traefik
  # task if this host path is missing, leaving port 80/443 down.
  mkdir -p "$INSTALL_DIR/traefik_dynamic"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"

  if [ -n "${SCRIPT_DIR:-}" ] && [ -d "$SCRIPT_DIR/agent" ]; then
    info "Copiando arquivos locais do instalador..."
    cp -a "$SCRIPT_DIR/agent" "$INSTALL_DIR/"
    cp -a "$SCRIPT_DIR/docker-compose.agent.yml" "$INSTALL_DIR/" 2>/dev/null || true
    [ -d "$SCRIPT_DIR/web/dist" ] && mkdir -p "$INSTALL_DIR/agent/static" && cp -a "$SCRIPT_DIR/web/dist/." "$INSTALL_DIR/agent/static/"
  elif [ -d "./agent" ]; then
    info "Copiando arquivos locais do instalador..."
    cp -a ./agent "$INSTALL_DIR/"
    cp -a ./docker-compose.agent.yml "$INSTALL_DIR/" 2>/dev/null || true
    [ -d "./web/dist" ] && mkdir -p "$INSTALL_DIR/agent/static" && cp -a ./web/dist/. "$INSTALL_DIR/agent/static/"
  else
    info "Baixando pacote oficial mais recente..."
    local tmp_tar="/tmp/setupimpa.tar.gz"
    if curl -fsSL -m 40 -o "$tmp_tar" "$SETUPIMPA_TARBALL_URL"; then
      tar -xzf "$tmp_tar" -C "$INSTALL_DIR"
      rm -f "$tmp_tar"
    else
      die "Não foi possível baixar o SetupImpa de $SETUPIMPA_TARBALL_URL. Verifique sua conexão."
    fi
  fi
  ok "Arquivos do painel instalados em $INSTALL_DIR"
}

start_agent() {
  PUBLIC_IP=$(curl -s4 --max-time 5 ifconfig.me 2>/dev/null || curl -s4 --max-time 5 icanhazip.com 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  mkdir -p /var/log

  docker rm -f setupimpa-agent >/dev/null 2>&1 || true

  info "Iniciando servidor do painel na porta $AGENT_PORT..."
  docker pull python:3.12-slim >/dev/null 2>&1 || true

  local docker_bin
  docker_bin="$(command -v docker 2>/dev/null || echo '/usr/bin/docker')"

  local port_flag="-p ${AGENT_PORT}:8877"
  if [ -f /root/dados_vps/panel_domain.json ]; then
    port_flag=""
    info "Domínio próprio detectado. Porta $AGENT_PORT mantida interna no Docker (não exposta no host)."
  fi

  docker run -d \
    --name setupimpa-agent \
    --restart unless-stopped \
    --network "$NETWORK_NAME" \
    ${port_flag} \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${docker_bin}:/usr/bin/docker:ro" \
    -v /root:/root \
    -v /opt/setupimpa:/opt/setupimpa \
    -v /var/log:/var/log \
    -e SETUPIMPA_TOKEN="$SETUPIMPA_TOKEN" \
    -e SETUPIMPA_NETWORK="$NETWORK_NAME" \
    -e SETUPIMPA_PUBLIC_IP="$PUBLIC_IP" \
    -e SETUPIMPA_VERSION="$SETUPIMPA_VERSION" \
    -w /opt/setupimpa/agent \
    python:3.12-slim \
    bash -c 'pip install -q fastapi uvicorn[standard] pydantic httpx docker PyYAML jinja2 >/dev/null 2>&1 && python -m uvicorn app:app --host 0.0.0.0 --port 8877' >/dev/null 2>&1

  # Aguarda inicialização
  local wait_count=0
  while [ $wait_count -lt 30 ]; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx setupimpa-agent; then
      break
    fi
    sleep 1
    wait_count=$((wait_count + 1))
  done

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx setupimpa-agent; then
    ok "Painel operacional e pronto para uso"
  else
    die "Falha ao iniciar o painel. Verifique com: docker logs setupimpa-agent"
  fi
}

main() {
  mkdir -p "$(dirname "$LOG_FILE")" "$DADOS_DIR"
  : > "$LOG_FILE"
  log "=== SetupImpa v${SETUPIMPA_VERSION} bootstrap start ==="
  impa_telemetry_init
  impa_telemetry "start"

  banner
  require_root

  step "1/4" "Verificando se o seu servidor é compatível..."
  validate_os
  check_disk
  ensure_deps

  step "2/4" "Preparando Docker e ambiente de rede..."
  ensure_docker
  impa_telemetry "docker_ready"

  step "3/4" "Instalando os arquivos do painel..."
  generate_token
  install_agent_files
  impa_telemetry "files_installed"

  step "4/4" "Iniciando o SetupImpa..."
  start_agent
  impa_telemetry "completed"
  log "=== SetupImpa bootstrap end ==="

  local panel_url="http://${PUBLIC_IP}:${AGENT_PORT}"
  if [ -f /root/dados_vps/panel_domain.json ]; then
    local configured_domain
    configured_domain=$(grep -o '"domain": *"[^"]*"' /root/dados_vps/panel_domain.json 2>/dev/null | cut -d'"' -f4)
    if [ -n "$configured_domain" ]; then
      panel_url="https://${configured_domain}"
    fi
  fi

  echo ""
  echo -e "  ${GREEN}╔══════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "  ${GREEN}║                                                              ║${RESET}"
  echo -e "  ${GREEN}║   🎉 INSTALAÇÃO CONCLUÍDA COM SUCESSO!                       ║${RESET}"
  echo -e "  ${GREEN}║                                                              ║${RESET}"
  echo -e "  ${GREEN}║   👉 ACESSE SEU PAINEL NO SEU NAVEGADOR:                    ║${RESET}"
  echo -e "  ${GREEN}║                                                              ║${RESET}"
  echo -e "  ${GREEN}║      🔗  ${BOLD}${CYAN}${panel_url}${RESET}${GREEN}                               ║${RESET}"
  echo -e "  ${GREEN}║                                                              ║${RESET}"
  echo -e "  ${GREEN}╠══════════════════════════════════════════════════════════════╣${RESET}"
  echo -e "  ${GREEN}║   💡 O QUE FAZER AGORA:                                      ║${RESET}"
  echo -e "  ${GREEN}║                                                              ║${RESET}"
  echo -e "  ${GREEN}║   1. Clique no link acima ou copie e cole no seu navegador   ║${RESET}"
  echo -e "  ${GREEN}║   2. Crie seu usuário e senha no primeiro acesso             ║${RESET}"
  echo -e "  ${GREEN}║   3. Instale suas ferramentas com apenas 1 clique!           ║${RESET}"
  echo -e "  ${GREEN}║                                                              ║${RESET}"
  echo -e "  ${GREEN}╚══════════════════════════════════════════════════════════════╝${RESET}"
  echo ""
}

main "$@"
