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
    appForm: {},
    authForm: { username: "", password: "", password2: "" },
    expandedApp: null,
    activeModal: null, // 'base' | 'app' | 'creds' | 'cf'
    modalData: null,
    cfConfigured: false,
    cfStatus: null,
    activeTab: "marketplace", // 'marketplace' | 'instances' | 'cloudflare' | 'base'
    searchQuery: "",
    selectedCategory: "all",
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
    await loadApps();
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

  // ── Metadados dos Apps (Estilo Hosteg) ──────────────────────────
  const APP_METAS = {
    base: {
      icon: "⚙️",
      name: "Infraestrutura Base",
      tag: "Obrigatório",
      ram: "512 MB RAM",
      category: "infra",
      desc: "Roteador Traefik v3 + Portainer CE com SSL/HTTPS automático e gerenciamento do cluster Docker.",
      includes: "Traefik v3, Portainer, Let's Encrypt SSL e Rede Pública",
      favorite: false,
    },
    evolution: {
      icon: "💬",
      name: "Evolution API v2",
      tag: "WhatsApp Oficial",
      ram: "1 GB RAM",
      category: "whatsapp",
      desc: "Conecta números de WhatsApp aos seus sistemas, robôs e automações por API com suporte a webhooks.",
      includes: "Banco PostgreSQL, SSL grátis e Rotas Traefik",
      favorite: true,
    },
    hermes: {
      icon: "🤖",
      name: "Hermes Agente IA",
      tag: "Inteligência Artificial",
      ram: "2 GB RAM",
      category: "ai",
      desc: "Agente de IA persistente com painel visual, memória e integrações para automação inteligente.",
      includes: "Painel visual protegido, proxy reverso e SSL grátis",
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

    // Filtra apps baseado na busca e categoria
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
              <div class="server-ip-box" title="Clique para copiar" onclick="navigator.clipboard.writeText('${ip}'); alert('IP copiado: ${ip}')">
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
            <p>Para você instalar qualquer aplicativo com endereço próprio e cadeado de segurança (HTTPS grátis), precisamos ativar o roteador do servidor.</p>
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
    return `
      <div class="page-title-row">
        <div>
          <h2>Infraestrutura Base do Servidor</h2>
          <p class="page-subtitle">Traefik v3 (Roteador de tráfego com SSL automático) e Portainer CE (Gerenciador de cluster).</p>
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
    `;
  }

  // ── Binds de Eventos ─────────────────────────────────────────────
  function bindEvents() {
    // Menu lateral (tabs)
    app.querySelectorAll("[data-tab]").forEach(btn => {
      btn.onclick = () => {
        state.activeTab = btn.dataset.tab;
        render();
      };
    });

    // Busca no marketplace
    const searchInput = document.getElementById("marketplace-search");
    if (searchInput) {
      searchInput.oninput = (e) => {
        state.searchQuery = e.target.value;
        render();
        // Mantém o foco e cursor no input após render
        const el = document.getElementById("marketplace-search");
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      };
    }

    // Filtro de categorias
    const catSelect = document.getElementById("marketplace-category");
    if (catSelect) {
      catSelect.onchange = (e) => {
        state.selectedCategory = e.target.value;
        render();
      };
    }

    // Botões de instalar app
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

    // Botão gerenciar app
    app.querySelectorAll("[data-manage-app]").forEach(btn => {
      btn.onclick = () => {
        state.activeTab = "instances";
        render();
      };
    });

    // Botão ativar base
    const baseBtn = document.getElementById("btn-quick-base") || document.getElementById("btn-open-base-modal");
    if (baseBtn) {
      baseBtn.onclick = () => {
        state.activeModal = "base";
        render();
      };
    }

    // Ver credenciais
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

    // Deletar instância
    app.querySelectorAll("[data-delete-inst]").forEach(btn => {
      btn.onclick = async () => {
        const instId = btn.dataset.deleteInst;
        if (!confirm(`Remover a instância "${instId}"?\nO container será desligado e o domínio será liberado.`)) return;
        try {
          toast(`Removendo ${instId}...`, "info");
          await api(`/api/instance/${instId}`, { method: "DELETE" });
          toast(`Instância ${instId} removida com sucesso.`, "ok");
          await loadApps();
          render();
        } catch (e) {
          toast("Erro ao remover: " + e.message, "err");
        }
      };
    });

    // Salvar CF Token na aba
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

    // Logout
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

  // ── Modais (Hosteg Clean) ────────────────────────────────────────
  function renderActiveModal() {
    if (!state.activeModal) return "";

    if (state.activeModal === "base") return renderBaseModal();
    if (state.activeModal === "app") return renderAppModal();
    if (state.activeModal === "creds") return renderCredsModal();
    return "";
  }

  function closeModal() {
    state.activeModal = null;
    state.modalData = null;
    render();
  }
  window.__closeModal = closeModal;

  // Modal 1: Ativação da Base
  function renderBaseModal() {
    const ip = state.status?.public_ip || "74.1.21.235";
    return `
      <div class="modal-backdrop">
        <div class="modal-box">
          <div class="modal-head">
            <h3>⚙️ Configuração do Servidor</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              Para suas ferramentas terem endereço próprio com SSL (HTTPS grátis), aponte um domínio para o IP da sua VPS:
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

  // Modal 2: Instalação de App
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
              <button class="btn-hosteg-primary full" onclick="navigator.clipboard.writeText(${JSON.stringify(data.creds)}); alert('Credenciais copiadas com sucesso!')">
                📋 Copiar Todas as Informações
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Bind de cliques de modal globais
  document.addEventListener("click", async (e) => {
    if (e.target.classList.contains("modal-backdrop")) {
      closeModal();
    }

    // Submeter Base
    if (e.target.id === "btn-submit-base") {
      const domain = (document.getElementById("base-domain")?.value || "").trim();
      const email = (document.getElementById("base-email")?.value || "").trim();
      if (!domain) return toast("Informe o domínio do painel.", "err");
      if (!email || !email.includes("@")) return toast("Informe um e-mail válido para o certificado SSL.", "err");

      state.baseForm.portainer_domain = domain;
      state.baseForm.email = email;
      state.baseForm.user = "admin";
      state.baseForm.password = "";

      try {
        toast("Configurando o servidor... aguarde alguns instantes.", "info");
        const res = await api("/api/install/base", { method: "POST", body: JSON.stringify(state.baseForm) });
        if (!res.ok) throw new Error(res.error || "Falha na instalação.");

        if (state.cfConfigured) {
          try {
            await api("/api/cloudflare/dns", { method: "POST", body: JSON.stringify({ domain }) });
            toast("Registro DNS criado na Cloudflare automaticamente!", "ok");
          } catch (_) {}
        }

        toast("Finalizando ativação do roteador...", "info");
        await api("/api/install/base/finish", { method: "POST", body: JSON.stringify({ confirm_cloudflare: true }) });
        closeModal();
        await loadApps();
        toast("Servidor ativado com sucesso!", "ok");
        render();
      } catch (err) {
        toast("Erro ao ativar servidor: " + err.message, "err");
      }
    }

    // Submeter App
    if (e.target.id === "btn-submit-app") {
      const a = state.currentApp;
      if (!a) return;

      document.querySelectorAll("[data-field-key]").forEach(inp => {
        state.appForm[inp.dataset.fieldKey] = inp.value.trim();
      });

      const domain = state.appForm.domain;
      const autoCf = document.getElementById("cf-auto-create")?.checked;

      if (autoCf && domain && state.cfConfigured) {
        try {
          toast(`Criando DNS para ${domain} na Cloudflare...`, "info");
          await api("/api/cloudflare/dns", { method: "POST", body: JSON.stringify({ domain }) });
          toast(`DNS para ${domain} criado na Cloudflare!`, "ok");
        } catch (e) {
          toast("Aviso Cloudflare: " + e.message, "warn");
        }
      }

      try {
        toast(`Iniciando instalação de ${a.name}...`, "info");
        closeModal();
        const job = await api(`/api/install/${a.id}`, { method: "POST", body: JSON.stringify({ params: state.appForm }) });
        await pollJob(job.job_id, a, job.instance_id);
      } catch (err) {
        toast("Erro ao instalar: " + err.message, "err");
      }
    }
  });

  async function pollJob(jobId, appMeta, instanceId) {
    for (let i = 0; i < 60; i++) {
      const job = await api(`/api/install/${jobId}`);
      if (job.status === "done" || job.status === "error") {
        const r = job.result || {};
        if (!r.ok) {
          toast(`Falha na instalação: ${r.error || JSON.stringify(r)}`, "err");
          return;
        }
        toast(`🎉 ${appMeta.name} instalado com sucesso!`, "ok");
        state.activeTab = "instances";
        await loadApps();
        render();
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    toast("Tempo limite aguardando container subir.", "err");
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
