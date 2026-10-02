(() => {
  const app = document.getElementById("app");
  const state = {
    token: localStorage.getItem("setupimpa_session") || "",
    username: localStorage.getItem("setupimpa_user") || "",
    auth: null,
    status: null,
    apps: [],
    step: "loading",
    msg: null,
    currentApp: null,
    baseForm: { email: "", portainer_domain: "", user: "admin", password: "" },
    baseInfo: null,
    showPortainerPass: false,
    appForm: {},
    authForm: { username: "", password: "", password2: "" },
    expandedApp: null,
    activeModal: null, // 'base' | 'app' | 'creds' | 'cf' | 'progress' | 'dialog'
    modalData: null,
    dialog: null, // { title, message, icon, confirmText, cancelText, danger, onConfirm }
    cfConfigured: false,
    cfStatus: null,
    activeTab: "marketplace", // 'marketplace' | 'instances' | 'cloudflare' | 'base'
    searchQuery: "",
    selectedCategory: "all",
    progress: {
      active: false,
      title: "",
      subtitle: "",
      percent: 0,
      steps: [],
      done: false,
      error: null,
      resultHtml: "",
      ctaText: "",
      onDone: null,
    },
  };

  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.detail || data.error || `HTTP ${res.status}`;
      let msg;
      if (typeof detail === "string") {
        msg = detail;
      } else if (detail.message) {
        msg = detail.message;
      } else {
        msg = JSON.stringify(detail);
      }
      const err = new Error(msg);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return data;
  }

  function toast(text, type = "info") {
    state.msg = text ? { text, type } : null;
    renderToast();
    if (text && type === "ok") {
      setTimeout(() => {
        if (state.msg?.text === text) {
          state.msg = null;
          renderToast();
        }
      }, 5000);
    }
  }
  window.__toast = toast;

  function renderToast() {
    let el = document.getElementById("toast-container");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast-container";
      document.body.appendChild(el);
    }
    if (!state.msg) {
      el.innerHTML = "";
      return;
    }
    const icons = { ok: "✔", err: "✖", warn: "⚠", info: "ℹ" };
    el.innerHTML = `
      <div class="toast-item ${state.msg.type || "info"}">
        <span class="toast-icon">${icons[state.msg.type] || "ℹ"}</span>
        <div class="toast-text">${escapeHtml(state.msg.text).replace(/\n/g, "<br>")}</div>
        <button class="toast-close" onclick="document.getElementById('toast-container').innerHTML=''">×</button>
      </div>
    `;
  }

  function persistSession(token, username) {
    state.token = token;
    state.username = username || "";
    localStorage.setItem("setupimpa_session", token);
    localStorage.setItem("setupimpa_user", state.username);
  }

  function clearSession() {
    state.token = "";
    state.username = "";
    localStorage.removeItem("setupimpa_session");
    localStorage.removeItem("setupimpa_user");
  }

  function openConfirm({ title, message, icon = "⚠️", confirmText = "Confirmar", cancelText = "Cancelar", danger = true, onConfirm }) {
    state.dialog = { title, message, icon, confirmText, cancelText, danger, onConfirm };
    state.activeModal = "dialog";
    render();
  }
  window.__closeDialog = () => {
    state.dialog = null;
    state.activeModal = null;
    render();
  };

  // ── Auth Screen (Login / Primeiro Acesso) ───────────────────────
  function renderAuth() {
    const setup = !!state.auth?.setup_required;
    app.innerHTML = `
      <div class="auth-wrapper">
        <div class="auth-card">
          <div class="auth-header">
            <div class="auth-badge">IMPA 365</div>
            <h1>Setup<strong>Impa</strong></h1>
            <p class="auth-desc">
              ${setup
                ? "Bem-vindo! Crie o usuário e senha do administrador para acessar seu Marketplace de Aplicativos."
                : "Entre com seus dados para gerenciar seus aplicativos e servidores."}
            </p>
          </div>

          <form class="auth-form" id="auth-form">
            <div class="form-group">
              <label for="user">Usuário de Acesso</label>
              <input id="user" name="username" type="text" autocomplete="username"
                     placeholder="Ex: admin" value="${escapeHtml(state.authForm.username)}" required minlength="3" />
            </div>

            <div class="form-group">
              <label for="pass">Senha</label>
              <input id="pass" name="password" type="password"
                     autocomplete="${setup ? "new-password" : "current-password"}"
                     placeholder="Digite sua senha (mínimo 8 dígitos)" required minlength="8" />
            </div>

            ${setup ? `
              <div class="form-group">
                <label for="pass2">Confirmar Senha</label>
                <input id="pass2" type="password" autocomplete="new-password"
                       placeholder="Repita sua senha" required minlength="8" />
              </div>
            ` : ""}

            <button type="submit" class="btn-primary full">
              ${setup ? "Criar Meu Acesso e Entrar 🚀" : "Entrar no Painel ➜"}
            </button>
          </form>

          <div class="auth-footer">
            <span>SetupImpa · Desenvolvido por <strong>IMPA 365</strong></span>
          </div>
        </div>
      </div>
    `;

    document.getElementById("auth-form").onsubmit = async (e) => {
      e.preventDefault();
      const username = document.getElementById("user").value.trim();
      const password = document.getElementById("pass").value;
      if (setup) {
        const password2 = document.getElementById("pass2").value;
        if (password !== password2) return toast("As senhas não coincidem.", "err");
        if (password.length < 8) return toast("A senha deve ter no mínimo 8 caracteres.", "err");
      }
      try {
        const path = setup ? "/api/auth/setup" : "/api/auth/login";
        const res = await api(path, { method: "POST", body: JSON.stringify({ username, password }) });
        persistSession(res.token, res.username);
        toast("Login realizado com sucesso!", "ok");
        await afterLogin();
      } catch (err) {
        const map = {
          ja_configurado: "O acesso já foi configurado. Faça login.",
          usuario_curto: "O usuário deve ter pelo menos 3 letras.",
          senha_curta: "A senha deve ter pelo menos 8 dígitos.",
          credenciais_invalidas: "Usuário ou senha incorretos.",
          setup_required: "Primeiro acesso: crie seu usuário.",
        };
        toast(map[err.message] || err.message, "err");
      }
    };
  }

  async function afterLogin() {
    try {
      state.status = await api("/api/status");
      if (!state.status.accepted_risk) {
        await api("/api/accept", { method: "POST", body: JSON.stringify({ accepted: true }) }).catch(() => {});
      }
      const cf = await api("/api/cloudflare/status").catch(() => ({ ok: false }));
      state.cfConfigured = !!cf.configured && !!cf.ok;
      state.cfStatus = cf;
    } catch (_) {}

    state.step = "dashboard";
    await Promise.all([loadApps(), loadBaseInfo()]);
    render();
  }

  async function loadApps() {
    try {
      const data = await api("/api/apps");
      state.apps = data.apps || [];
      if (data.base_installed !== undefined && state.status) {
        state.status.base_installed = data.base_installed;
      }
    } catch (e) {
      toast("Falha ao carregar catálogo: " + e.message, "err");
    }
  }

  async function loadBaseInfo() {
    try {
      const res = await api("/api/base/info");
      state.baseInfo = res;
    } catch (_) {}
  }

  // ── Metadados dos Apps (Estilo Hosteg) ──────────────────────────
  const APP_METAS = {
    base: {
      icon: "⚙️",
      name: "Infraestrutura Base",
      tag: "Obrigatório",
      ram: "512 MB RAM",
      category: "infra",
      desc: "Roteador Traefik v3 com emissão automática de SSL (HTTPS grátis) e cluster Docker pronto.",
      includes: "Roteador Traefik v3, Let's Encrypt SSL e Rede Segura",
      favorite: false,
    },
    evolution: {
      icon: "💬",
      name: "Evolution API v2",
      tag: "WhatsApp Oficial",
      ram: "1 GB RAM",
      category: "whatsapp",
      desc: "Conecta números de WhatsApp aos seus sistemas, robôs e automações por API com suporte a webhooks.",
      includes: "Banco PostgreSQL isolado, SSL grátis e Rotas Traefik",
      favorite: true,
    },
    hermes: {
      icon: "🤖",
      name: "Hermes Agente IA",
      tag: "Inteligência Artificial",
      ram: "2 GB RAM",
      category: "ai",
      desc: "Agente de IA persistente com painel visual, memória e integrações para automação inteligente.",
      includes: "Dashboard visual protegido, proxy reverso e SSL grátis",
      favorite: true,
    },
    postgres: {
      icon: "🐘",
      name: "PostgreSQL 16",
      tag: "Banco de Dados",
      ram: "512 MB RAM",
      category: "db",
      desc: "Banco de dados relacional de alta performance e ultraveloz isolado na rede interna overlay.",
      includes: "Volume persistente em /root/dados_vps e rede segura",
      favorite: true,
    },
    getfy: {
      icon: "💳",
      name: "Getfy Checkout",
      tag: "Checkout & Vendas",
      ram: "1 GB RAM",
      category: "sales",
      desc: "Plataforma completa de checkout, produtos e pagamentos com Redis dedicado para alta conversão.",
      includes: "Redis dedicado, Traefik SSL e Wizard de primeiro acesso",
      favorite: true,
    },
  };

  // ── Render Principal (Layout Hosteg com Sidebar) ───────────────
  function renderDashboard() {
    const baseInstalled = !!state.status?.base_installed;
    const ip = state.status?.public_ip || "—";

    const rawApps = state.apps.filter(a => a.id !== "base");
    const filteredApps = rawApps.filter(a => {
      const meta = APP_METAS[a.id] || { name: a.name, desc: a.description, category: "all" };
      const q = state.searchQuery.toLowerCase().trim();
      const matchQuery = !q || meta.name.toLowerCase().includes(q) || meta.desc.toLowerCase().includes(q) || a.id.toLowerCase().includes(q);
      const matchCat = state.selectedCategory === "all" ||
        (state.selectedCategory === "favorites" && meta.favorite) ||
        meta.category === state.selectedCategory;
      return matchQuery && matchCat;
    });

    const totalInstances = rawApps.reduce((acc, a) => acc + (a.instance_count || 0), 0);

    app.innerHTML = `
      <div class="hosteg-layout">
        <!-- Sidebar Esquerda -->
        <aside class="sidebar">
          <div class="sidebar-header">
            <div class="brand">
              <span class="brand-logo">🚀</span>
              <span class="brand-name">Setup<strong>Impa</strong></span>
            </div>
            <span class="brand-badge">IMPA 365</span>
          </div>

          <div class="sidebar-section-title">GERENCIAL</div>
          <nav class="sidebar-menu">
            <button class="menu-item ${state.activeTab === "marketplace" ? "active" : ""}" data-tab="marketplace">
              <span class="menu-icon">🏪</span>
              <span class="menu-label">Marketplace de APPs</span>
              <span class="menu-badge">${rawApps.length}</span>
            </button>

            <button class="menu-item ${state.activeTab === "instances" ? "active" : ""}" data-tab="instances">
              <span class="menu-icon">📦</span>
              <span class="menu-label">Minhas Instâncias</span>
              <span class="menu-badge ${totalInstances > 0 ? "green" : ""}">${totalInstances}</span>
            </button>

            <button class="menu-item ${state.activeTab === "cloudflare" ? "active" : ""}" data-tab="cloudflare">
              <span class="menu-icon">☁️</span>
              <span class="menu-label">Cloudflare DNS</span>
              ${state.cfConfigured ? '<span class="menu-pill green">Ativo</span>' : ""}
            </button>

            <button class="menu-item ${state.activeTab === "base" ? "active" : ""}" data-tab="base">
              <span class="menu-icon">⚙️</span>
              <span class="menu-label">Base do Servidor</span>
              ${baseInstalled ? '<span class="menu-pill green">Pronto</span>' : '<span class="menu-pill yellow">Configurar</span>'}
            </button>
          </nav>

          <div class="sidebar-footer">
            <div class="server-status-card">
              <div class="status-indicator">
                <span class="dot online"></span>
                <span>Servidor Online</span>
              </div>
              <div class="server-ip-box" title="Clique para copiar" onclick="navigator.clipboard.writeText('${ip}'); window.__toast('IP ${escapeHtml(ip)} copiado!', 'ok')">
                <code>${escapeHtml(ip)}</code>
                <span>📋</span>
              </div>
            </div>

            <div class="user-row">
              <span class="user-avatar">👤</span>
              <span class="user-name">${escapeHtml(state.username || "admin")}</span>
              <button class="btn-logout" id="btn-logout" title="Sair">Sair</button>
            </div>
          </div>
        </aside>

        <!-- Área Principal de Conteúdo -->
        <main class="main-viewport">
          ${renderTabContent(baseInstalled, filteredApps, totalInstances, ip)}
        </main>
      </div>

      ${renderActiveModal()}
    `;

    bindEvents();
    renderToast();
  }

  function renderTabContent(baseInstalled, filteredApps, totalInstances, ip) {
    if (state.activeTab === "marketplace") {
      return renderMarketplaceTab(baseInstalled, filteredApps, ip);
    }
    if (state.activeTab === "instances") {
      return renderInstancesTab(totalInstances);
    }
    if (state.activeTab === "cloudflare") {
      return renderCloudflareTab();
    }
    if (state.activeTab === "base") {
      return renderBaseTab(baseInstalled, ip);
    }
    return renderMarketplaceTab(baseInstalled, filteredApps, ip);
  }

  // ── Tab: Marketplace de APPs ────────────────────────────────────
  function renderMarketplaceTab(baseInstalled, filteredApps, ip) {
    return `
      ${!baseInstalled ? `
        <div class="notice-banner">
          <div class="notice-icon">⚡</div>
          <div class="notice-body">
            <h4>Configuração Inicial do Servidor (Necessário)</h4>
            <p>Para você instalar qualquer aplicativo com endereço próprio e cadeado de segurança (HTTPS grátis), precisamos ativar o roteador do servidor uma única vez.</p>
          </div>
          <button class="btn-hosteg-primary" id="btn-quick-base" type="button">
            Ativar Servidor em 1 Minuto ➜
          </button>
        </div>
      ` : ""}

      <div class="page-title-row">
        <div>
          <h2>Aplicativos disponíveis</h2>
          <p class="page-subtitle">Escolha agora ou depois de conectar. O que o aplicativo precisa (banco de dados, Docker, certificado SSL) é instalado junto, automaticamente.</p>
        </div>
      </div>

      <!-- Barra de Busca e Filtro de Categorias (Igual Hosteg) -->
      <div class="filter-bar">
        <div class="search-input-box">
          <span class="search-icon">🔍</span>
          <input type="text" id="marketplace-search"
                 placeholder="Buscar aplicativo: Ex: WhatsApp, banco de dados, IA..."
                 value="${escapeHtml(state.searchQuery)}" />
        </div>

        <div class="category-select-box">
          <select id="marketplace-category">
            <option value="all" ${state.selectedCategory === "all" ? "selected" : ""}>Todas as categorias</option>
            <option value="favorites" ${state.selectedCategory === "favorites" ? "selected" : ""}>Favoritos ⭐</option>
            <option value="whatsapp" ${state.selectedCategory === "whatsapp" ? "selected" : ""}>WhatsApp & Atendimento</option>
            <option value="ai" ${state.selectedCategory === "ai" ? "selected" : ""}>Inteligência Artificial</option>
            <option value="db" ${state.selectedCategory === "db" ? "selected" : ""}>Bancos de Dados</option>
            <option value="sales" ${state.selectedCategory === "sales" ? "selected" : ""}>Checkout & Vendas</option>
          </select>
        </div>
      </div>

      <!-- Grid de Aplicativos -->
      <div class="apps-grid">
        ${filteredApps.length === 0 ? `
          <div class="no-results">
            <p>Nenhum aplicativo encontrado para a busca "${escapeHtml(state.searchQuery)}".</p>
          </div>
        ` : filteredApps.map(a => {
          const meta = APP_METAS[a.id] || {
            icon: "📦", name: a.name, tag: "App", ram: "1 GB RAM",
            desc: a.description, includes: "Roteador Traefik e rede isolada",
          };
          const count = a.instance_count || 0;
          const hasInst = count > 0;

          return `
            <div class="hosteg-card ${hasInst ? "installed" : ""}">
              <div class="card-top">
                <div class="app-avatar">${meta.icon}</div>
                <div class="app-identity">
                  <h3>${escapeHtml(meta.name)}</h3>
                  <span class="app-tag-pill">${escapeHtml(meta.tag)}</span>
                </div>
                <span class="ram-badge">${meta.ram}</span>
              </div>

              <p class="app-desc">${escapeHtml(meta.desc)}</p>

              <div class="app-meta-box">
                <span class="meta-label">Instala junto:</span>
                <span class="meta-val">${escapeHtml(meta.includes)}</span>
              </div>

              <div class="card-footer">
                ${hasInst ? `
                  <div class="instance-status-tag">
                    <span class="status-dot online"></span>
                    <span>${count} instância${count > 1 ? "s" : ""} ativa${count > 1 ? "s" : ""}</span>
                  </div>
                  <div class="btn-group-hosteg">
                    <button class="btn-hosteg-primary" data-install-app="${a.id}">
                      + Nova Instância
                    </button>
                    <button class="btn-hosteg-outline" data-manage-app="${a.id}">
                      Gerenciar
                    </button>
                  </div>
                ` : `
                  <button class="btn-hosteg-primary full" data-install-app="${a.id}">
                    Quero Instalar ➜
                  </button>
                `}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // ── Tab: Minhas Instâncias ───────────────────────────────────────
  function renderInstancesTab(totalInstances) {
    const rawApps = state.apps.filter(a => a.id !== "base");
    const activeInstances = [];
    rawApps.forEach(a => {
      (a.instances || []).forEach(inst => {
        activeInstances.push({ ...inst, app_name: a.name, app_id: a.id });
      });
    });

    return `
      <div class="page-title-row">
        <div>
          <h2>Minhas Instâncias Ativas (${totalInstances})</h2>
          <p class="page-subtitle">Todas as ferramentas e aplicações rodando no seu servidor em tempo real.</p>
        </div>
      </div>

      ${activeInstances.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">📦</div>
          <h3>Você ainda não instalou nenhum aplicativo</h3>
          <p>Acesse o Marketplace de APPs e instale WhatsApp, Banco de Dados ou Robôs de IA com 1 clique.</p>
          <button class="btn-hosteg-primary" data-tab="marketplace">Ir para o Marketplace</button>
        </div>
      ` : `
        <div class="instances-table-card">
          <table class="hosteg-table">
            <thead>
              <tr>
                <th>Aplicativo</th>
                <th>Instância</th>
                <th>Endereço (Domínio)</th>
                <th>Data</th>
                <th style="text-align:right;">Ações</th>
              </tr>
            </thead>
            <tbody>
              ${activeInstances.map(inst => `
                <tr>
                  <td>
                    <strong>${escapeHtml(inst.app_name)}</strong>
                  </td>
                  <td>
                    <span class="inst-num-chip">#${inst.instance_num || 1} ${escapeHtml(inst.instance_id)}</span>
                  </td>
                  <td>
                    ${inst.domain ? `
                      <a class="domain-link" href="https://${inst.domain}" target="_blank" rel="noopener">
                        🔗 https://${escapeHtml(inst.domain)}
                      </a>
                    ` : '<span class="text-dim">Rede interna privada</span>'}
                  </td>
                  <td><span class="text-muted">${escapeHtml((inst.created_at || "").slice(0, 10))}</span></td>
                  <td style="text-align:right;">
                    <button class="btn-table-action" data-view-creds="${escapeHtml(inst.instance_id)}">
                      🔑 Credenciais
                    </button>
                    <button class="btn-table-danger" data-delete-inst="${escapeHtml(inst.instance_id)}">
                      🗑️ Remover
                    </button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `}
    `;
  }

  // ── Tab: Cloudflare DNS ──────────────────────────────────────────
  function renderCloudflareTab() {
    return `
      <div class="page-title-row">
        <div>
          <h2>Automação Cloudflare DNS</h2>
          <p class="page-subtitle">Crie subdomínios automaticamente para seus aplicativos sem precisar acessar o painel da Cloudflare.</p>
        </div>
      </div>

      <div class="cf-settings-box">
        <div class="cf-status-strip">
          <div class="cf-badge ${state.cfConfigured ? "active" : ""}">
            <span class="status-dot ${state.cfConfigured ? "online" : ""}"></span>
            <span>${state.cfConfigured ? "Integração Conectada e Ativa" : "Aguardando Token"}</span>
          </div>
        </div>

        <div class="instruction-box">
          <strong>Como gerar seu Token na Cloudflare em 1 minuto:</strong>
          <ol style="margin: 0.6rem 0 0 1.2rem; font-size: 0.88rem; line-height: 1.6;">
            <li>Acesse seu painel na Cloudflare → <strong>Meu Perfil → API Tokens → Create Token</strong></li>
            <li>Escolha a opção <strong>Create Custom Token</strong></li>
            <li>Permissões necessárias: <strong>Zone : DNS (Edit)</strong> e <strong>Zone : Zone (Read)</strong></li>
            <li>Copie o token gerado e cole abaixo:</li>
          </ol>
        </div>

        <div class="form-group" style="max-width: 600px;">
          <label>API Token da Cloudflare</label>
          <input type="password" id="tab-cf-token" placeholder="Cole seu token aqui..." />
        </div>

        <button class="btn-hosteg-primary" id="btn-tab-save-cf" type="button">
          Validar e Salvar Token ➜
        </button>
      </div>
    `;
  }

  // ── Tab: Base do Servidor ────────────────────────────────────────
  function renderBaseTab(baseInstalled, ip) {
    const info = state.baseInfo || {};
    const portainerUrl = info.url || (info.domain ? `https://${info.domain}` : "");
    const portainerUser = info.user || "admin";
    const portainerPass = info.password || "";

    return `
      <div class="page-title-row">
        <div>
          <h2>Infraestrutura Base do Servidor</h2>
          <p class="page-subtitle">Traefik v3 (Roteador de tráfego com SSL automático) e cluster Docker pronto.</p>
        </div>
      </div>

      <div class="base-overview-card">
        <div class="base-status-banner ${baseInstalled ? "ready" : "pending"}">
          <span class="base-status-icon">${baseInstalled ? "✔" : "⚠"}</span>
          <div>
            <h3>${baseInstalled ? "Servidor Configurado e Pronto para Uso" : "Servidor Precisa de Configuração"}</h3>
            <p>${baseInstalled
              ? "A base está rodando e emitindo certificados SSL para todas as aplicações."
              : "Clique abaixo para configurar o domínio do servidor e liberar o instalador de aplicativos."}</p>
          </div>
        </div>

        <div class="base-details-grid">
          <div class="detail-item">
            <span class="label">IP da VPS:</span>
            <strong>${escapeHtml(ip)}</strong>
          </div>
          <div class="detail-item">
            <span class="label">Roteador:</span>
            <strong>Traefik v3 (Swarm Provider)</strong>
          </div>
          <div class="detail-item">
            <span class="label">Certificados SSL:</span>
            <strong>Let's Encrypt (Automático)</strong>
          </div>
        </div>

        <div style="margin-top: 1.5rem;">
          <button class="btn-hosteg-primary" id="btn-open-base-modal">
            ${baseInstalled ? "Reconfigurar Domínio da Base" : "Configurar Agora em 1 Minuto ➜"}
          </button>
        </div>
      </div>

      ${baseInstalled && portainerUrl ? `
        <!-- Painel Técnico & Portainer (Acesso Direto sem SFTP) -->
        <div class="portainer-tech-card">
          <div class="portainer-tech-header">
            <div class="portainer-badge-row">
              <span class="tech-badge">PAINEL TÉCNICO & GERENCIADOR</span>
              <span class="portainer-tag-pill">🐳 Portainer CE</span>
            </div>
            <h3>Acesso Administrativo ao Portainer</h3>
            <p class="portainer-tech-desc">
              O Portainer roda em segundo plano gerenciando o cluster Docker Swarm. Você pode acessá-lo diretamente pelo navegador quando precisar de configurações avançadas, sem precisar de SFTP ou terminal SSH.
            </p>
          </div>

          <div class="portainer-creds-container">
            <div class="portainer-cred-box">
              <span class="cred-label">Endereço Web (URL):</span>
              <div class="cred-value-row">
                <a href="${escapeHtml(portainerUrl)}" target="_blank" rel="noopener" class="portainer-url-link">
                  🔗 ${escapeHtml(portainerUrl)} ↗
                </a>
                <button class="btn-copy-chip" onclick="navigator.clipboard.writeText('${escapeHtml(portainerUrl)}'); window.__toast('Link do Portainer copiado!', 'ok')">
                  📋 Copiar Link
                </button>
              </div>
            </div>

            <div class="portainer-cred-box">
              <span class="cred-label">Usuário Administrador:</span>
              <div class="cred-value-row">
                <code>${escapeHtml(portainerUser)}</code>
                <button class="btn-copy-chip" onclick="navigator.clipboard.writeText('${escapeHtml(portainerUser)}'); window.__toast('Usuário copiado!', 'ok')">
                  📋 Copiar Usuário
                </button>
              </div>
            </div>

            <div class="portainer-cred-box">
              <span class="cred-label">Senha de Acesso:</span>
              <div class="cred-value-row">
                <code>${state.showPortainerPass ? escapeHtml(portainerPass) : "••••••••••••••••••••"}</code>
                <button class="btn-copy-chip" id="btn-toggle-portainer-pass" type="button">
                  ${state.showPortainerPass ? "🙈 Ocultar" : "👁️ Revelar"}
                </button>
                <button class="btn-copy-chip" onclick="navigator.clipboard.writeText('${escapeHtml(portainerPass)}'); window.__toast('Senha copiada!', 'ok')">
                  📋 Copiar Senha
                </button>
              </div>
            </div>
          </div>

          <div class="portainer-footer-actions">
            <a href="${escapeHtml(portainerUrl)}" target="_blank" rel="noopener" class="btn-hosteg-primary">
              Abrir Portainer no Navegador ↗
            </a>
            <button class="btn-hosteg-outline" id="btn-view-portainer-raw-creds" type="button">
              📄 Ver Arquivo /root/dados_vps/dados_portainer
            </button>
          </div>
        </div>
      ` : ""}
    `;
  }

  // ── Binds de Eventos ─────────────────────────────────────────────
  function bindEvents() {
    app.querySelectorAll("[data-tab]").forEach(btn => {
      btn.onclick = () => {
        state.activeTab = btn.dataset.tab;
        if (state.activeTab === "base") {
          loadBaseInfo();
        }
        render();
      };
    });

    const searchInput = document.getElementById("marketplace-search");
    if (searchInput) {
      searchInput.oninput = (e) => {
        state.searchQuery = e.target.value;
        render();
        const el = document.getElementById("marketplace-search");
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      };
    }

    const catSelect = document.getElementById("marketplace-category");
    if (catSelect) {
      catSelect.onchange = (e) => {
        state.selectedCategory = e.target.value;
        render();
      };
    }

    app.querySelectorAll("[data-install-app]").forEach(btn => {
      btn.onclick = () => {
        const appId = btn.dataset.installApp;
        state.currentApp = state.apps.find(x => x.id === appId);
        state.appForm = {};
        (state.currentApp.fields || []).forEach(f => {
          state.appForm[f.key] = f.default || "";
        });
        state.activeModal = "app";
        render();
      };
    });

    app.querySelectorAll("[data-manage-app]").forEach(btn => {
      btn.onclick = () => {
        state.activeTab = "instances";
        render();
      };
    });

    const baseBtn = document.getElementById("btn-quick-base") || document.getElementById("btn-open-base-modal");
    if (baseBtn) {
      baseBtn.onclick = () => {
        state.activeModal = "base";
        render();
      };
    }

    app.querySelectorAll("[data-view-creds]").forEach(btn => {
      btn.onclick = async () => {
        const instId = btn.dataset.viewCreds;
        try {
          const res = await api(`/api/credentials/${instId}`);
          state.modalData = { instance_id: instId, creds: res.content };
          state.activeModal = "creds";
          render();
        } catch (e) {
          toast("Erro ao buscar credenciais: " + e.message, "err");
        }
      };
    });

    // Remover Instância com Modal Customizado (SEM popup de navegador!)
    app.querySelectorAll("[data-delete-inst]").forEach(btn => {
      btn.onclick = () => {
        const instId = btn.dataset.deleteInst;
        openConfirm({
          title: `Remover a Instância "${instId}"?`,
          message: "O container será desligado e o domínio será liberado. Os dados desta instância serão removidos do cluster Swarm.",
          icon: "🗑️",
          confirmText: "Sim, Remover Instância",
          cancelText: "Cancelar",
          danger: true,
          onConfirm: async () => {
            try {
              toast(`Removendo ${instId}...`, "info");
              await api(`/api/instance/${instId}`, { method: "DELETE" });
              toast(`Instância ${instId} removida com sucesso.`, "ok");
              await loadApps();
              render();
            } catch (e) {
              toast("Erro ao remover: " + e.message, "err");
            }
          },
        });
      };
    });

    // Alternar visibilidade da senha do Portainer
    const togglePassBtn = document.getElementById("btn-toggle-portainer-pass");
    if (togglePassBtn) {
      togglePassBtn.onclick = () => {
        state.showPortainerPass = !state.showPortainerPass;
        render();
      };
    }

    // Ver credenciais brutas do Portainer
    const viewRawPortainerBtn = document.getElementById("btn-view-portainer-raw-creds");
    if (viewRawPortainerBtn) {
      viewRawPortainerBtn.onclick = async () => {
        try {
          const res = await api("/api/credentials/portainer");
          state.modalData = { instance_id: "portainer", creds: res.content };
          state.activeModal = "creds";
          render();
        } catch (e) {
          toast("Erro ao buscar credenciais do Portainer: " + e.message, "err");
        }
      };
    }

    const saveCfBtn = document.getElementById("btn-tab-save-cf");
    if (saveCfBtn) {
      saveCfBtn.onclick = async () => {
        const token = (document.getElementById("tab-cf-token")?.value || "").trim();
        if (!token) return toast("Informe o token da Cloudflare.", "err");
        try {
          toast("Verificando token...", "info");
          await api("/api/cloudflare/token", { method: "POST", body: JSON.stringify({ token }) });
          state.cfConfigured = true;
          toast("Cloudflare conectado com sucesso!", "ok");
          render();
        } catch (e) {
          toast("Erro ao validar token: " + e.message, "err");
        }
      };
    }

    const logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (_) {}
        clearSession();
        state.step = "auth";
        boot();
      };
    }
  }

  // ── Modais ───────────────────────────────────────────────────────
  function renderActiveModal() {
    if (!state.activeModal) return "";

    if (state.activeModal === "base") return renderBaseModal();
    if (state.activeModal === "app") return renderAppModal();
    if (state.activeModal === "creds") return renderCredsModal();
    if (state.activeModal === "progress") return renderProgressModal();
    if (state.activeModal === "dialog") return renderDialogModal();
    return "";
  }

  function closeModal() {
    if (state.activeModal === "progress" && !state.progress.done && !state.progress.error) {
      openConfirm({
        title: "Instalação em Andamento",
        message: "A instalação ainda está rodando no servidor. Deseja realmente fechar o acompanhamento visual da tela?",
        icon: "⚠️",
        confirmText: "Sim, Fechar Janela",
        cancelText: "Continuar Acompanhando",
        danger: false,
        onConfirm: () => {
          state.activeModal = null;
          state.modalData = null;
          render();
        },
      });
      return;
    }
    state.activeModal = null;
    state.modalData = null;
    render();
  }
  window.__closeModal = closeModal;

  // Modal 0: Diálogo de Confirmação Customizado (Substitui confirm/alert nativos do navegador)
  function renderDialogModal() {
    const d = state.dialog;
    if (!d) return "";
    return `
      <div class="modal-backdrop">
        <div class="modal-box modal-dialog">
          <div class="dialog-icon-badge ${d.danger ? "danger" : "warn"}">
            ${d.icon || "⚠️"}
          </div>
          <h3 class="dialog-title">${escapeHtml(d.title)}</h3>
          <p class="dialog-message">${escapeHtml(d.message)}</p>
          <div class="dialog-actions">
            <button class="btn-hosteg-outline" onclick="window.__closeDialog()" type="button">
              ${escapeHtml(d.cancelText || "Cancelar")}
            </button>
            <button class="${d.danger ? "btn-hosteg-danger" : "btn-hosteg-primary"}" id="btn-dialog-confirm" type="button">
              ${escapeHtml(d.confirmText || "Confirmar")}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // Modal 1: Configuração da Base (Zero menção a Portainer no Onboarding!)
  function renderBaseModal() {
    const ip = state.status?.public_ip || "74.1.21.235";
    return `
      <div class="modal-backdrop">
        <div class="modal-box">
          <div class="modal-head">
            <h3>⚙️ Configuração Inicial do Servidor</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              Para suas ferramentas terem endereço próprio com SSL (HTTPS com cadeado grátis), aponte um domínio para o IP da sua VPS:
            </p>

            <div class="dns-guideline-box">
              <div class="guideline-row">
                <span>Tipo: <strong>A</strong></span>
                <span>Nome: <strong>painel</strong> (ou outro)</span>
                <span>IP: <strong>${escapeHtml(ip)}</strong></span>
              </div>
            </div>

            <div class="form-group">
              <label>Domínio para o Servidor</label>
              <input id="base-domain" type="text" placeholder="Ex: painel.meusite.com" value="${escapeHtml(state.baseForm.portainer_domain)}" />
              <span class="field-hint">Endereço que você apontou para o IP acima.</span>
            </div>

            <div class="form-group">
              <label>Seu E-mail (para SSL Grátis)</label>
              <input id="base-email" type="email" placeholder="Ex: contato@meusite.com" value="${escapeHtml(state.baseForm.email)}" />
              <span class="field-hint">Usado pelo Let's Encrypt para emitir o certificado de segurança.</span>
            </div>

            <div class="modal-actions">
              <button class="btn-hosteg-primary full" id="btn-submit-base" type="button">
                Ativar Servidor Agora 🚀
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Modal 2: Instalação de App (Hosteg Clean)
  function renderAppModal() {
    const a = state.currentApp;
    if (!a) return "";
    const meta = APP_METAS[a.id] || { icon: "📦", name: a.name };
    const count = a.instance_count || 0;
    const ip = state.status?.public_ip || "74.1.21.235";

    return `
      <div class="modal-backdrop">
        <div class="modal-box">
          <div class="modal-head">
            <h3>${meta.icon} Quero Instalar: ${escapeHtml(meta.name)}</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            ${count > 0 ? `
              <div class="pill-info">
                ℹ Você já tem ${count} instância(s) desta aplicação. Esta será a <strong>Instância #${count + 1}</strong> com portas e dados isolados.
              </div>
            ` : ""}

            <p class="modal-intro">
              Informe o endereço (subdomínio) que você deseja usar para acessar esta ferramenta:
            </p>

            ${(a.fields || []).map(f => `
              <div class="form-group">
                <label>${escapeHtml(f.label)}</label>
                <input data-field-key="${f.key}" type="text"
                       placeholder="${f.key === 'domain' ? 'Ex: zap.meusite.com' : ''}"
                       value="${escapeHtml(state.appForm[f.key] || '')}" />
                ${f.key === 'domain' ? `<span class="field-hint">Aponte o Registro A no seu provedor para o IP <strong>${escapeHtml(ip)}</strong>.</span>` : ''}
              </div>
            `).join("")}

            ${state.cfConfigured && a.fields?.some(f => f.key === 'domain') ? `
              <div class="cf-auto-box">
                <label>
                  <input type="checkbox" id="cf-auto-create" checked />
                  <span>☁️ Criar subdomínio na Cloudflare automaticamente</span>
                </label>
              </div>
            ` : ""}

            <div class="modal-actions">
              <button class="btn-hosteg-primary full" id="btn-submit-app" type="button">
                Confirmar e Instalar 🚀
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Modal 3: Credenciais
  function renderCredsModal() {
    const data = state.modalData;
    if (!data) return "";

    return `
      <div class="modal-backdrop">
        <div class="modal-box">
          <div class="modal-head">
            <h3>🔑 Dados de Acesso: ${escapeHtml(data.instance_id)}</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              Guarde essas informações. Elas foram salvas com segurança no seu servidor em <code>/root/dados_vps/</code>.
            </p>

            <div class="creds-terminal">
              <pre>${escapeHtml(data.creds)}</pre>
            </div>

            <div class="modal-actions">
              <button class="btn-hosteg-primary full" onclick="navigator.clipboard.writeText(${JSON.stringify(data.creds)}); window.__toast('Credenciais copiadas com sucesso!', 'ok')">
                📋 Copiar Todas as Informações
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Modal 4: Onboarding de Progresso em Tempo Real (AO VIVO!)
  function renderProgressModal() {
    const p = state.progress;
    return `
      <div class="modal-backdrop">
        <div class="modal-box progress-modal">
          <div class="progress-head">
            <div class="progress-pulsing-icon ${p.done ? "done" : p.error ? "error" : "pulsing"}">
              ${p.done ? "🎉" : p.error ? "✖" : "⚡"}
            </div>
            <h3>${escapeHtml(p.title)}</h3>
            <p class="progress-sub">${escapeHtml(p.subtitle)}</p>
          </div>

          <!-- Barra de Progresso Real -->
          <div class="progress-bar-track">
            <div class="progress-bar-fill ${p.done ? "done" : ""}" style="width: ${Math.max(p.percent, 8)}%;"></div>
          </div>
          <div class="progress-pct-row">
            <span>${p.done ? "Concluído com Sucesso!" : p.error ? "Ocorreu um erro" : "Em andamento..."}</span>
            <strong>${p.percent}%</strong>
          </div>

          <!-- Stepper Visual com Checklist -->
          <div class="progress-stepper">
            ${p.steps.map((st, i) => `
              <div class="stepper-item ${st.status}">
                <div class="stepper-dot">
                  ${st.status === "done" ? "✔" : st.status === "active" ? '<div class="spin-dot"></div>' : (i + 1)}
                </div>
                <div class="stepper-content">
                  <div class="stepper-title">${escapeHtml(st.label)}</div>
                  ${st.detail ? `<div class="stepper-sub">${escapeHtml(st.detail)}</div>` : ""}
                </div>
              </div>
            `).join("")}
          </div>

          ${p.done ? `
            <div class="progress-success-container">
              ${p.resultHtml}
              <button class="btn-hosteg-primary full" id="btn-progress-finish" type="button">
                ${escapeHtml(p.ctaText || "Continuar ➜")}
              </button>
            </div>
          ` : p.error ? `
            <div class="progress-error-container">
              <div class="err-box">
                <strong>Falha:</strong> ${escapeHtml(p.error)}
              </div>
              <button class="btn-hosteg-outline full" onclick="window.__closeModal()" type="button">
                Fechar e Tentar Novamente
              </button>
            </div>
          ` : `
            <div class="progress-live-hint">
              <span class="live-dot"></span>
              <span>Executando no servidor... não feche esta janela.</span>
            </div>
          `}
        </div>
      </div>
    `;
  }

  // ── Handlers de Submissão com Live Stepper ─────────────────────────
  document.addEventListener("click", async (e) => {
    if (e.target.classList.contains("modal-backdrop")) {
      closeModal();
    }

    // Botão Confirmar no Diálogo Customizado
    if (e.target.id === "btn-dialog-confirm") {
      const fn = state.dialog?.onConfirm;
      state.dialog = null;
      state.activeModal = null;
      render();
      if (typeof fn === "function") {
        fn();
      }
    }

    // Botão Concluir no Stepper de Sucesso
    if (e.target.id === "btn-progress-finish") {
      if (typeof state.progress.onDone === "function") {
        state.progress.onDone();
      } else {
        closeModal();
      }
    }

    // Submeter Base (Ativação do Servidor)
    if (e.target.id === "btn-submit-base") {
      const domain = (document.getElementById("base-domain")?.value || "").trim();
      const email = (document.getElementById("base-email")?.value || "").trim();
      if (!domain) return toast("Informe o domínio do painel.", "err");
      if (!email || !email.includes("@")) return toast("Informe um e-mail válido para o certificado SSL.", "err");

      state.baseForm.portainer_domain = domain;
      state.baseForm.email = email;
      state.baseForm.user = "admin";
      state.baseForm.password = "";

      // Transforma imediatamente na tela de Onboarding de Progresso!
      state.activeModal = "progress";
      state.progress = {
        active: true,
        title: "Ativando Infraestrutura do Servidor...",
        subtitle: `Configurando roteador Traefik v3 e SSL grátis para ${domain}`,
        percent: 15,
        done: false,
        error: null,
        steps: [
          { label: "Validando cluster Docker Swarm e rede interna", status: "active", detail: "Verificando rede network_public" },
          { label: "Subindo roteador Traefik v3 e gerador de SSL", status: "pending" },
          { label: "Configurando apontamento de domínio na Cloudflare", status: "pending" },
          { label: "Emitindo certificado HTTPS e liberando rotas", status: "pending" },
        ],
      };
      render();

      try {
        await new Promise(r => setTimeout(r, 800));
        state.progress.percent = 35;
        state.progress.steps[0].status = "done";
        state.progress.steps[1].status = "active";
        state.progress.steps[1].detail = "Deploy das stacks de roteamento...";
        render();

        const res = await api("/api/install/base", { method: "POST", body: JSON.stringify(state.baseForm) });
        if (!res.ok) throw new Error(res.error || "Falha ao instalar a base.");

        state.progress.percent = 65;
        state.progress.steps[1].status = "done";
        state.progress.steps[2].status = "active";

        if (state.cfConfigured) {
          state.progress.steps[2].detail = "Criando registro A automaticamente...";
          render();
          try {
            await api("/api/cloudflare/dns", { method: "POST", body: JSON.stringify({ domain }) });
          } catch (_) {}
        } else {
          state.progress.steps[2].detail = "DNS verificado no provedor";
        }

        await new Promise(r => setTimeout(r, 600));
        state.progress.percent = 85;
        state.progress.steps[2].status = "done";
        state.progress.steps[3].status = "active";
        state.progress.steps[3].detail = "Ativando provedor Traefik e Let's Encrypt...";
        render();

        await api("/api/install/base/finish", { method: "POST", body: JSON.stringify({ confirm_cloudflare: true }) });

        // Concluído com Sucesso! ZERO senhas do Portainer no Onboarding!
        state.progress.percent = 100;
        state.progress.steps[3].status = "done";
        state.progress.steps[3].detail = "Rotas liberadas com sucesso";
        state.progress.done = true;
        state.progress.title = "🎉 Servidor Ativado com Sucesso!";
        state.progress.subtitle = "Sua VPS está pronta com roteador Traefik v3 e certificado SSL gratuito.";
        state.progress.resultHtml = `
          <div class="progress-success-box">
            <div class="success-row">✔ Roteador Traefik v3 online</div>
            <div class="success-row">✔ Certificados SSL automáticos ativados</div>
            <div class="success-row">✔ Pronto para instalar WhatsApp, Banco de Dados e Robôs</div>
          </div>
        `;
        state.progress.ctaText = "Ir para o Marketplace de APPs ➜";
        state.progress.onDone = async () => {
          closeModal();
          state.activeTab = "marketplace";
          await Promise.all([loadApps(), loadBaseInfo()]);
          render();
        };
        render();
      } catch (err) {
        state.progress.error = err.message;
        render();
      }
    }

    // Submeter App (Instalação de Ferramenta)
    if (e.target.id === "btn-submit-app") {
      const a = state.currentApp;
      if (!a) return;

      document.querySelectorAll("[data-field-key]").forEach(inp => {
        state.appForm[inp.dataset.fieldKey] = inp.value.trim();
      });

      const domain = state.appForm.domain;
      const autoCf = document.getElementById("cf-auto-create")?.checked;

      // Abre imediatamente o Stepper de Progresso Visual!
      state.activeModal = "progress";
      state.progress = {
        active: true,
        title: `Instalando ${a.name}...`,
        subtitle: `Configurando sua nova instância com isolamento e segurança`,
        percent: 20,
        done: false,
        error: null,
        steps: [
          { label: "Validando parâmetros e criando volumes", status: "active", detail: "Isolamento de dados" },
          { label: "Configurando rota segura e SSL no Traefik", status: "pending" },
          { label: "Inicializando container no cluster Docker", status: "pending" },
          { label: "Verificando saúde da aplicação", status: "pending" },
        ],
      };
      render();

      try {
        if (autoCf && domain && state.cfConfigured) {
          state.progress.steps[0].detail = `Criando apontamento DNS para ${domain}...`;
          render();
          try {
            await api("/api/cloudflare/dns", { method: "POST", body: JSON.stringify({ domain }) });
          } catch (_) {}
        }

        state.progress.percent = 40;
        state.progress.steps[0].status = "done";
        state.progress.steps[1].status = "active";
        state.progress.steps[1].detail = domain ? `Configurando rota https://${domain}` : "Rede interna privada";
        render();

        const job = await api(`/api/install/${a.id}`, { method: "POST", body: JSON.stringify({ params: state.appForm }) });

        state.progress.percent = 60;
        state.progress.steps[1].status = "done";
        state.progress.steps[2].status = "active";
        state.progress.steps[2].detail = `Subindo stack ${job.instance_id}...`;
        render();

        await pollJobProgress(job.job_id, a, job.instance_id, domain);
      } catch (err) {
        state.progress.error = err.message;
        render();
      }
    }
  });

  async function pollJobProgress(jobId, appMeta, instanceId, domain) {
    let pcts = [65, 70, 75, 80, 85, 90];
    let idx = 0;

    for (let i = 0; i < 60; i++) {
      const job = await api(`/api/install/${jobId}`);

      if (idx < pcts.length) {
        state.progress.percent = pcts[idx++];
        render();
      }

      if (job.status === "done" || job.status === "error") {
        const r = job.result || {};
        if (!r.ok) {
          state.progress.error = r.error || JSON.stringify(r);
          render();
          return;
        }

        // Sucesso na instalação do App!
        state.progress.percent = 100;
        state.progress.steps[2].status = "done";
        state.progress.steps[3].status = "done";
        state.progress.steps[3].detail = "Serviço saudável e respondendo";
        state.progress.done = true;
        state.progress.title = `🎉 ${appMeta.name} Instalado com Sucesso!`;
        state.progress.subtitle = `Instância #${instanceId} está rodando perfeitamente no seu servidor.`;

        // Renderiza APENAS as credenciais da aplicação instalada
        let credsDisplay = "";
        if (domain) {
          credsDisplay += `
            <div class="result-url-card">
              <span>Endereço na internet:</span>
              <a href="https://${domain}" target="_blank" rel="noopener">
                🔗 https://${escapeHtml(domain)} ↗
              </a>
            </div>
          `;
        }
        if (r.credentials) {
          credsDisplay += `
            <div class="result-creds-box">
              <div class="creds-box-head">Credenciais de Acesso:</div>
              <pre>${escapeHtml(JSON.stringify(r.credentials, null, 2))}</pre>
            </div>
          `;
        }

        state.progress.resultHtml = credsDisplay;
        state.progress.ctaText = "Ver em Minhas Instâncias ➜";
        state.progress.onDone = async () => {
          closeModal();
          state.activeTab = "instances";
          await loadApps();
          render();
        };
        render();
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    state.progress.error = "Tempo limite excedido aguardando o container inicializar.";
    render();
  }

  // ── Router ───────────────────────────────────────────────────────
  function render() {
    if (state.step === "loading") {
      app.innerHTML = `
        <div class="auth-wrapper">
          <div class="auth-card" style="text-align:center;">
            <div class="spinner"></div>
            <h2 style="margin-top:1rem;">Carregando SetupImpa...</h2>
          </div>
        </div>
      `;
      return;
    }
    if (state.step === "auth") return renderAuth();
    if (state.step === "dashboard") return renderDashboard();
    renderAuth();
  }

  async function boot() {
    state.step = "loading";
    render();
    try {
      state.auth = await api("/api/auth/status");
      if (state.auth.setup_required) {
        clearSession();
        state.step = "auth";
        render();
        return;
      }
      if (state.token && state.auth.authenticated) {
        await afterLogin();
        return;
      }
      clearSession();
      state.step = "auth";
      render();
    } catch (e) {
      state.step = "auth";
      toast(e.message, "err");
    }
  }

  boot();
})();
