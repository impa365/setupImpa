#!/usr/bin/env bash
# SetupImpa — bootstrap do painel web (IMPA 365)
# Uso: bash install.sh   ou   bash <(curl -sSL ...)
set -euo pipefail

SETUPIMPA_VERSION="0.1.0"
AGENT_PORT="${SETUPIMPA_PORT:-8877}"
INSTALL_DIR="/opt/setupimpa"
DADOS_DIR="/root/dados_vps"
LOG_FILE="/var/log/setupimpa.log"
NETWORK_NAME="${SETUPIMPA_NETWORK:-network_public}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
WHITE='\033[0;97m'
RESET='\033[0m'

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE" >/dev/null; echo -e "${WHITE}$*${RESET}"; }
ok()  { echo -e "${GREEN}✓${RESET} ${WHITE}$1${RESET}"; log "OK: $1"; }
die() { echo -e "${RED}✗${RESET} ${WHITE}$1${RESET}"; log "FATAL: $1"; exit 1; }
info(){ echo -e "${CYAN}•${RESET} ${WHITE}$1${RESET}"; }

banner() {
  clear 2>/dev/null || true
  echo -e "${YELLOW}===================================================================================================${RESET}"
  echo -e "${YELLOW}=${RESET}                                                                                                 ${YELLOW}=${RESET}"
  echo -e "${YELLOW}=${RESET}   ${WHITE}SetupImpa${RESET}  ${CYAN}v${SETUPIMPA_VERSION}${RESET}                                                              ${YELLOW}=${RESET}"
  echo -e "${YELLOW}=${RESET}   ${WHITE}Painel web de instalacao — IMPA 365${RESET}                                                    ${YELLOW}=${RESET}"
  echo -e "${YELLOW}=${RESET}   ${CYAN}https://impa365.com${RESET}                                                                   ${YELLOW}=${RESET}"
  echo -e "${YELLOW}=${RESET}                                                                                                 ${YELLOW}=${RESET}"
  echo -e "${YELLOW}===================================================================================================${RESET}"
  echo ""
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Execute como root: sudo bash install.sh"
}

validate_os() {
  [ -f /etc/os-release ] || die "SO nao suportado (/etc/os-release ausente)"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "$ID" in
    debian)
      case "$VERSION_ID" in
        11|12|13) ok "SO: Debian $VERSION_ID" ;;
        *) die "Debian $VERSION_ID nao homologado (use 11, 12 ou 13)" ;;
      esac
      ;;
    ubuntu)
      case "$VERSION_ID" in
        20.04|22.04|23.04|23.10|24.04|24.10|25.04) ok "SO: Ubuntu $VERSION_ID" ;;
        *) die "Ubuntu $VERSION_ID nao homologado (use 20.04+)" ;;
      esac
      ;;
    *) die "SO nao homologado: $ID $VERSION_ID (Debian/Ubuntu)" ;;
  esac
  ARCH=$(uname -m)
  ok "Arquitetura: $ARCH"
}

check_disk() {
  local free needed
  free=$(df -B1 / | awk 'NR==2{print $4}')
  needed=$((5 * 1024 * 1024 * 1024))
  if [ -n "$free" ] && [ "$free" -lt "$needed" ]; then
    die "Espaco insuficiente. Livre=${free} bytes, minimo≈5GB"
  fi
  ok "Espaco em disco OK"
}

ensure_deps() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq curl jq openssl ca-certificates dnsutils >/dev/null 2>&1 || \
    apt-get install -y curl jq openssl ca-certificates >/dev/null
  ok "Dependencias basicas"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    ok "Docker ja instalado"
  else
    info "Instalando Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    ok "Docker instalado"
  fi

  if docker info 2>/dev/null | grep -q 'Swarm: active'; then
    ok "Swarm ativo"
  else
    info "Inicializando Docker Swarm..."
    docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')" 2>/dev/null \
      || docker swarm init
    ok "Swarm inicializado"
  fi

  if docker network ls --format '{{.Name}}' | grep -qx "$NETWORK_NAME"; then
    ok "Rede $NETWORK_NAME existe"
  else
    docker network create --driver overlay --attachable "$NETWORK_NAME"
    ok "Rede $NETWORK_NAME criada"
  fi
}

generate_token() {
  if [ -f "$DADOS_DIR/setupimpa_token" ]; then
    SETUPIMPA_TOKEN=$(cat "$DADOS_DIR/setupimpa_token")
  else
    mkdir -p "$DADOS_DIR"
    SETUPIMPA_TOKEN=$(openssl rand -hex 24)
    echo "$SETUPIMPA_TOKEN" > "$DADOS_DIR/setupimpa_token"
    chmod 600 "$DADOS_DIR/setupimpa_token"
  fi
  ok "Token do painel gerado"
}

install_agent_files() {
  mkdir -p "$INSTALL_DIR"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"

  if [ -n "${SCRIPT_DIR:-}" ] && [ -d "$SCRIPT_DIR/agent" ]; then
    info "Copiando agent de $SCRIPT_DIR"
    cp -a "$SCRIPT_DIR/agent" "$INSTALL_DIR/"
    cp -a "$SCRIPT_DIR/docker-compose.agent.yml" "$INSTALL_DIR/" 2>/dev/null || true
    [ -d "$SCRIPT_DIR/web/dist" ] && mkdir -p "$INSTALL_DIR/agent/static" && cp -a "$SCRIPT_DIR/web/dist/." "$INSTALL_DIR/agent/static/"
  elif [ -d "./agent" ]; then
    cp -a ./agent "$INSTALL_DIR/"
    cp -a ./docker-compose.agent.yml "$INSTALL_DIR/" 2>/dev/null || true
    [ -d "./web/dist" ] && mkdir -p "$INSTALL_DIR/agent/static" && cp -a ./web/dist/. "$INSTALL_DIR/agent/static/"
  else
    die "Arquivos do agent nao encontrados. Rode a partir do repositorio setupimpa/"
  fi
  ok "Arquivos instalados em $INSTALL_DIR"
}

start_agent() {
  PUBLIC_IP=$(curl -s4 --max-time 5 ifconfig.me 2>/dev/null || curl -s4 --max-time 5 icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
  mkdir -p /var/log

  # Prefer docker run with host docker socket
  docker rm -f setupimpa-agent 2>/dev/null || true

  docker run -d \
    --name setupimpa-agent \
    --restart unless-stopped \
    -p "${AGENT_PORT}:8877" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /root:/root \
    -v /opt/setupimpa:/opt/setupimpa \
    -v /var/log:/var/log \
    -e SETUPIMPA_TOKEN="$SETUPIMPA_TOKEN" \
    -e SETUPIMPA_NETWORK="$NETWORK_NAME" \
    -e SETUPIMPA_PUBLIC_IP="$PUBLIC_IP" \
    -e SETUPIMPA_VERSION="$SETUPIMPA_VERSION" \
    -w /opt/setupimpa/agent \
    python:3.12-slim \
    bash -c 'pip install -q fastapi uvicorn[standard] pydantic httpx docker PyYAML jinja2 && python -m uvicorn app:app --host 0.0.0.0 --port 8877'

  sleep 3
  if docker ps --format '{{.Names}}' | grep -qx setupimpa-agent; then
    ok "Agent rodando na porta $AGENT_PORT"
  else
    die "Falha ao iniciar setupimpa-agent — veja: docker logs setupimpa-agent"
  fi

  echo ""
  echo -e "${YELLOW}===================================================================================================${RESET}"
  echo -e "  ${GREEN}SetupImpa pronto!${RESET}"
  echo -e "  Painel:  ${CYAN}http://${PUBLIC_IP}:${AGENT_PORT}${RESET}"
  echo -e "  Acesso:  ${WHITE}no primeiro acesso, crie usuario e senha no painel${RESET}"
  echo -e "  Log:     ${WHITE}${LOG_FILE}${RESET}"
  echo -e "${YELLOW}===================================================================================================${RESET}"
  echo ""
  echo -e "${WHITE}Abra o link no navegador e defina seu login.${RESET}"
}

main() {
  mkdir -p "$(dirname "$LOG_FILE")" "$DADOS_DIR"
  : > "$LOG_FILE"
  log "=== SetupImpa v${SETUPIMPA_VERSION} bootstrap start ==="
  banner
  require_root
  validate_os
  check_disk
  ensure_deps
  ensure_docker
  generate_token
  install_agent_files
  start_agent
  log "=== SetupImpa bootstrap end ==="
}

main "$@"
