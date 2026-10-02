# SetupImpa

Painel web de instalação no estilo SetupOrion, com gates do **IMPA Migrator** (preflight, DNS, Traefik Docker 29+/swarm, Portainer admin recovery, validação 1/1).

Desenvolvido pela **IMPA 365**.

## One-liner (na VPS)

Execute diretamente como root no terminal SSH:

```bash
bash <(curl -sSL https://setup.impa365.com)
```

Ou copie o repositório para a VPS e rode manualmente:

```bash
cd setupimpa
sudo bash install.sh
```

O script:
1. Valida SO (Debian 11–13 / Ubuntu 20.04+), root e disco
2. Instala Docker + Swarm + rede `network_public` se necessario
3. Sobe o agent na porta **8877**
4. Imprime `http://IP:8877` e o **token**

## Fluxo no painel

1. Abrir `http://IP:8877`
2. **Primeiro acesso:** criar usuario + senha do painel
3. Proximos acessos: login com essas credenciais
4. Gate "estou ciente" → Preflight → Base → DNS → Catalogo

Credenciais do painel ficam em `/root/dados_vps/setupimpa_admin.json` (hash PBKDF2).
Sessoes em `/root/dados_vps/setupimpa_sessions.json`.

## Apps MVP

| App | Stack | Dominio | Multi-instância |
|---|---|---|---|
| Traefik + Portainer | `traefik`, `portainer` | sim (Portainer) | não |
| PostgreSQL (Padrão Orion) | `postgres`, `postgres_2`, ... | não (rede interna) | ✅ |
| Evolution API v2 | `evolution`, `evolution_2`, ... | sim | ✅ |
| Hermes Agent | `hermes`, `hermes_2`, ... | sim | ✅ |
| Getfy (checkout) | `getfy`, `getfy_2`, ... | sim | ✅ |
| OmniRoute Gateway AI | `omniroute`, `omniroute_2`, ... | sim | ✅ |
| 9Router Gateway AI | `9router`, `9router_2`, ... | sim | ✅ |

Credenciais em `/root/dados_vps/dados_*`.

## Multi-Instância

Todas as apps (exceto a base Traefik+Portainer) suportam múltiplas instâncias na mesma VPS.

### Como funciona

1. A **primeira** instância de uma app usa o nome simples: `evolution`, com volumes `evolution_instances`, router `evolution`, etc.
2. A **segunda** instância recebe sufixo `_2`: stack `evolution_2`, volumes `evolution_2_instances`, router Traefik `evolution_2`, etc.
3. Cada instância é isolada: stack própria, volumes próprios, rota Traefik própria.
4. O **registry** (`/root/dados_vps/setupimpa_instances.json`) rastreia todas as instâncias com credenciais, domínios e metadados.

### No painel

- O card de cada app mostra **quantas instâncias** estão rodando
- Botão **"+ Nova instância"** para adicionar mais
- Expandir para ver detalhes de cada instância (domínio, data, credenciais)
- **Remover** instância individual (remove stack + volumes + registro)

### Naming Convention

| Instância | Stack | Volumes | Router Traefik |
|---|---|---|---|
| 1ª Evolution | `evolution` | `evolution_instances`, `evolution_store` | `evolution` |
| 2ª Evolution | `evolution_2` | `evolution_2_instances`, `evolution_2_store` | `evolution_2` |
| 3ª Evolution | `evolution_3` | `evolution_3_instances`, `evolution_3_store` | `evolution_3` |
| 1ª Getfy | `getfy` | `getfy_storage`, `getfy_env`, `getfy_redis` | `getfy` |
| 2ª Getfy | `getfy_2` | `getfy_2_storage`, `getfy_2_env`, `getfy_2_redis` | `getfy_2` |

## API

Header: `Authorization: Bearer <session>`

Auth:
- `GET /api/auth/status`
- `POST /api/auth/setup` `{ "username", "password" }` — so no primeiro acesso
- `POST /api/auth/login`
- `POST /api/auth/logout`

Install:
- `GET /api/status`
- `POST /api/preflight`
- `POST /api/accept`
- `POST /api/install/base`
- `POST /api/install/base/finish`
- `POST /api/dns/check` `{ "domain": "..." }`
- `GET /api/apps` — lista apps com `instances[]` e `instance_count`
- `POST /api/install/{app}` `{ "params": { ... } }` — cria nova instância automaticamente
- `GET /api/install/{job_id}`
- `GET /api/validate/{app}`
- `GET /api/credentials/{instance_id}`

Cloudflare DNS:
- `GET /api/cloudflare/status` — token configurado/válido?
- `POST /api/cloudflare/token` `{ "token": "..." }` — salvar API token
- `POST /api/cloudflare/dns` `{ "domain", "ip?", "proxied?" }` — criar/atualizar A record
- `DELETE /api/cloudflare/dns/{domain}` — remover A record
- `POST /api/cloudflare/zone` `{ "domain" }` — buscar zone_id

Instances:
- `GET /api/instances` — todas as instâncias
- `GET /api/instances/{app_id}` — instâncias de um app
- `GET /api/instance/{instance_id}` — detalhes
- `DELETE /api/instance/{instance_id}` — remove stack + desregistra

## Checklist de teste E2E

- [ ] VPS Ubuntu 22.04/24.04 limpa (ou com Docker)
- [ ] `sudo bash install.sh` imprime URL + token
- [ ] Abrir painel, autenticar com token
- [ ] Preflight todos OK (ou warn greenfield se Docker ja existe)
- [ ] Instalar base com email + dominio Portainer
- [ ] Apontar A record → IP; "Verificar DNS" OK
- [ ] Login Portainer funciona com usuario/senha gerados
- [ ] Instalar Postgres → `dados_postgres` preenchido; service `1/1`
- [ ] Instalar **2ª instância** Postgres → stack `postgres_2`; service `1/1`
- [ ] Instalar Evolution com dominio → DNS + HTTPS
- [ ] Instalar **2ª Evolution** com domínio diferente → stack `evolution_2`
- [ ] Remover instância pelo painel → stack removida do Swarm
- [ ] Instalar Hermes com dominio → dashboard basic-auth
- [ ] Instalar Getfy com dominio → HTTPS + acessar /docker-setup para criar admin
- [ ] Log em `/var/log/setupimpa.log`
- [ ] Registry `/root/dados_vps/setupimpa_instances.json` correto

## Diferenciais vs SetupOrion

- Painel web (nao so menu TTY)
- **Multi-instância** com registry, naming automático e UI de gerenciamento
- Preflight SO/disco/arch
- DNS gate + deteccao Cloudflare
- Traefik v3.6.1 + `providers.swarm` + `DOCKER_API_VERSION=1.45`
- Middlewares `@swarm` desde o dia 1
- Portainer admin init com recovery de timeout
- Validacao pos-deploy (stacks / replicas)
- Remoção individual de instâncias (stack rm + desregistro)

## Estrutura

```
setupimpa/
  install.sh
  docker-compose.agent.yml
  agent/                       # FastAPI + static UI
    app.py                     # API principal
    installer/
      auth.py                  # Admin + sessões PBKDF2
      base.py                  # Traefik + Portainer
      checks.py                # Preflight / DNS
      cloudflare.py            # Cloudflare DNS automation
      portainer_client.py      # Portainer API
      registry.py              # Multi-instance registry
      validate.py              # Pós-deploy check
      apps/
        postgres.py
        evolution.py
        hermes.py
        getfy.py
    static/
      index.html
      assets/
        app.js                 # SPA multi-instância
        styles.css
  README.md
```

## Seguranca

- No primeiro acesso o usuario define login/senha do painel
- Feche a porta 8877 apos o setup (`ufw deny 8877` / security group)
- Senhas do painel nunca em texto puro (PBKDF2)

## Créditos

Este projeto utiliza conceitos, padrões de deployment e referências
estruturais inspirados no **[SetupOrion](https://github.com/oriondesign2015/setuporion)**,
projeto de código aberto desenvolvido por **Orion Design**.

Reconhecemos e agradecemos a contribuição do SetupOrion como referência
para a arquitetura de deployment Docker Swarm + Portainer + Traefik.

Desenvolvido por **IMPA 365** — [impa365.com](https://impa365.com)
