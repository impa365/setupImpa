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

  // ── Top Navigation Bar ─────────────────────────────────────────
  function topbar() {
    const ip = state.status?.public_ip || "detectando...";
    const baseInstalled = !!state.status?.base_installed;
    return `
      <header class="navbar">
        <div class="nav-left">
          <div class="brand">
            <span class="brand-logo">🚀</span>
            <span class="brand-name">Setup<strong>Impa</strong></span>
            <span class="brand-tag">v0.2.0</span>
          </div>
          <div class="server-pill" title="IP público do servidor">
            <span class="status-dot online"></span>
            <span class="server-label">VPS:</span>
            <strong class="server-ip" onclick="navigator.clipboard.writeText('${ip}'); alert('IP copiado!')">${escapeHtml(ip)} 📋</strong>
          </div>
        </div>
        <div class="nav-right">
          <button class="nav-btn ghost" id="btn-open-cf" type="button" title="Configurar automação Cloudflare">
            ☁️ Cloudflare DNS ${state.cfConfigured ? '<span class="pill-mini green">Ativo</span>' : ""}
          </button>
          <div class="user-chip">
            <span class="user-icon">👤</span>
            <span class="user-name">${escapeHtml(state.username || "admin")}</span>
          </div>
          <button class="nav-btn outline" id="btn-logout" type="button">Sair</button>
        </div>
      </header>
    `;
  }

  function bindTopbar() {
    const logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (_) {}
        clearSession();
        state.step = "auth";
        boot();
      };
    }
    const cfBtn = document.getElementById("btn-open-cf");
    if (cfBtn) {
      cfBtn.onclick = () => {
        state.activeModal = "cf";
        render();
      };
    }
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
                ? "Bem-vindo! Crie o usuário e senha do administrador para acessar o painel do seu servidor."
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
            <span>Desenvolvido por <strong>IMPA 365</strong></span>
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
      // Auto-aceita risco em background (sem tela intermediária que confunde o usuário)
      if (!state.status.accepted_risk) {
        await api("/api/accept", { method: "POST", body: JSON.stringify({ accepted: true }) }).catch(() => {});
      }
      // Verifica Cloudflare status
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

  // ── Dashboard (Painel Principal) ──────────────────────────────
  const APP_METAS = {
    base: {
      icon: "⚙️",
      name: "Infraestrutura Base",
      tag: "Obrigatório",
      desc: "Roteador Traefik v3 + Portainer CE com SSL/HTTPS automático para suas ferramentas.",
    },
    evolution: {
      icon: "💬",
      name: "Evolution API (WhatsApp)",
      tag: "WhatsApp Oficial",
      desc: "Conecte números de WhatsApp para criar robôs de atendimento, chatbots e disparos automáticos.",
    },
    postgres: {
      icon: "🐘",
      name: "Banco PostgreSQL 16",
      tag: "Banco de Dados",
      desc: "Banco de dados isolado e ultraveloz para armazenar informações com máxima segurança.",
    },
    hermes: {
      icon: "🤖",
      name: "Hermes Agente IA",
      tag: "Inteligência Artificial",
      desc: "Agente inteligente autônomo com dashboard visual para automação de processos.",
    },
    getfy: {
      icon: "💳",
      name: "Getfy Checkout",
      tag: "Checkout & Vendas",
      desc: "Sistema completo de checkout, produtos e pagamentos com Redis dedicado.",
    },
  };

  function renderDashboard() {
    const baseInstalled = !!state.status?.base_installed;
    const ip = state.status?.public_ip || "—";

    app.innerHTML = `
      <div class="layout">
        ${topbar()}

        <main class="main-content">
          ${!baseInstalled ? `
            <section class="banner-alert">
              <div class="banner-left">
                <span class="banner-icon-large">⚡</span>
                <div>
                  <h2>Configuração Inicial do Servidor (1 Minuto)</h2>
                  <p>Para você instalar suas ferramentas com endereço próprio e cadeado de segurança (HTTPS grátis), precisamos ativar a base do servidor.</p>
                </div>
              </div>
              <button class="btn-primary" id="btn-start-base" type="button">
                Ativar Servidor Agora ➜
              </button>
            </section>
          ` : ""}

          <div class="content-header">
            <div>
              <h1>Catálogo de Ferramentas</h1>
              <p class="subtitle">Escolha o que deseja instalar. Você pode ter <strong>múltiplas instâncias</strong> da mesma ferramenta sem nenhum conflito.</p>
            </div>
            ${baseInstalled ? `
              <div class="status-summary">
                <span class="pill-green">🟢 Servidor Operacional</span>
              </div>
            ` : ""}
          </div>

          <div class="cards-grid">
            ${state.apps.filter(a => a.id !== "base").map(a => {
              const meta = APP_METAS[a.id] || { icon: "📦", name: a.name, tag: "App", desc: a.description };
              const count = a.instance_count || 0;
              const hasInstances = count > 0;
              const isExpanded = state.expandedApp === a.id;
              const isBlocked = a.blocked;

              return `
                <div class="app-card ${hasInstances ? "has-instances" : ""}">
                  <div class="card-head">
                    <span class="card-icon">${meta.icon}</span>
                    <div class="card-title-group">
                      <span class="card-tag">${meta.tag}</span>
                      <h3>${escapeHtml(meta.name)}</h3>
                    </div>
                  </div>

                  <p class="card-desc">${escapeHtml(meta.desc)}</p>

                  <div class="card-status-bar">
                    <span class="status-chip ${hasInstances ? "active" : "inactive"}">
                      ${hasInstances ? `🟢 ${count} ativa${count > 1 ? "s" : ""}` : "⚪ Nenhuma ativa"}
                    </span>
                    <span class="multi-indicator">Multi-instância</span>
                  </div>

                  <div class="card-buttons">
                    <button class="btn-primary full" data-install-app="${a.id}" ${isBlocked ? "disabled title='Configure a base primeiro'" : ""}>
                      ${hasInstances ? "+ Nova Instância" : "Instalar Ferramenta ➜"}
                    </button>
                    ${hasInstances ? `
                      <button class="btn-subtle full" data-toggle-instances="${a.id}">
                        ${isExpanded ? "▲ Ocultar Instâncias" : `▼ Gerenciar Instâncias (${count})`}
                      </button>
                    ` : ""}
                  </div>

                  ${isExpanded && hasInstances ? `
                    <div class="instances-drawer">
                      <div class="drawer-header">Instâncias Ativas (${count})</div>
                      <div class="instances-list">
                        ${a.instances.map(inst => `
                          <div class="instance-row">
                            <div class="inst-col-info">
                              <strong class="inst-id">#${inst.instance_num || 1} · ${escapeHtml(inst.instance_id)}</strong>
                              <span class="inst-domain">
                                ${inst.domain ? `<a href="https://${inst.domain}" target="_blank" rel="noopener">🔗 ${escapeHtml(inst.domain)}</a>` : "Rede interna privada"}
                              </span>
                            </div>
                            <div class="inst-col-actions">
                              <button class="btn-mini outline" data-view-creds="${escapeHtml(inst.instance_id)}">
                                🔑 Senhas / Acesso
                              </button>
                              <button class="btn-mini danger" data-delete-inst="${escapeHtml(inst.instance_id)}">
                                🗑️
                              </button>
                            </div>
                          </div>
                        `).join("")}
                      </div>
                    </div>
                  ` : ""}
                </div>
              `;
            }).join("")}
          </div>
        </main>
      </div>

      ${renderActiveModal()}
    `;

    bindTopbar();
    bindDashboardEvents();
    renderToast();
  }

  function bindDashboardEvents() {
    // Botão ativar base
    const baseBtn = document.getElementById("btn-start-base");
    if (baseBtn) {
      baseBtn.onclick = () => {
        state.activeModal = "base";
        render();
      };
    }

    // Instalar ferramenta
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

    // Expandir/recolher instâncias
    app.querySelectorAll("[data-toggle-instances]").forEach(btn => {
      btn.onclick = () => {
        const appId = btn.dataset.toggleInstances;
        state.expandedApp = state.expandedApp === appId ? null : appId;
        render();
      };
    });

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
        if (!confirm(`Tem certeza que deseja remover a instância "${instId}"?\nIsso irá parar a aplicação e liberar o domínio.`)) return;
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
  }

  // ── Modals (Simples e Visuais) ─────────────────────────────────
  function renderActiveModal() {
    if (!state.activeModal) return "";

    if (state.activeModal === "base") return renderBaseModal();
    if (state.activeModal === "app") return renderAppModal();
    if (state.activeModal === "creds") return renderCredsModal();
    if (state.activeModal === "cf") return renderCloudflareModal();
    return "";
  }

  function closeModal() {
    state.activeModal = null;
    state.modalData = null;
    render();
  }

  // Modal 1: Ativação da Base (Traefik + Portainer)
  function renderBaseModal() {
    const ip = state.status?.public_ip || "74.1.21.235";
    return `
      <div class="modal-backdrop">
        <div class="modal-box">
          <div class="modal-head">
            <h3>⚙️ Ativação do Servidor</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              Para suas ferramentas funcionarem na internet com endereço próprio e SSL (HTTPS grátis), precisamos configurar o roteador do servidor.
            </p>

            <div class="instruction-box">
              <strong>👉 Como apontar seu domínio:</strong>
              <div class="dns-step">
                Vá onde você registrou seu domínio (Cloudflare, Hostinger, etc.) e crie um apontamento:
                <div class="dns-record">
                  <span>Tipo: <strong>A</strong></span>
                  <span>Nome: <strong>painel</strong> (ou outro subdomínio)</span>
                  <span>IP: <strong>${escapeHtml(ip)}</strong></span>
                </div>
              </div>
            </div>

            <div class="form-group">
              <label>Domínio do Painel</label>
              <input id="base-domain" type="text" placeholder="Ex: painel.meusite.com" value="${escapeHtml(state.baseForm.portainer_domain)}" />
              <span class="field-hint">Endereço que você apontou para o IP acima.</span>
            </div>

            <div class="form-group">
              <label>Seu E-mail (para SSL Grátis)</label>
              <input id="base-email" type="email" placeholder="Ex: contato@meusite.com" value="${escapeHtml(state.baseForm.email)}" />
              <span class="field-hint">Usado pelo Let's Encrypt para emitir o cadeado HTTPS grátis.</span>
            </div>

            <div class="modal-actions">
              <button class="btn-primary full" id="btn-submit-base" type="button">
                Iniciar Configuração 🚀
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Modal 2: Instalação de Aplicação
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
            <h3>${meta.icon} Instalar ${escapeHtml(meta.name)}</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            ${count > 0 ? `
              <div class="pill-info">
                ℹ Você já tem ${count} instância(s) desta ferramenta. Esta será a <strong>Instância #${count + 1}</strong>, 100% isolada das outras.
              </div>
            ` : ""}

            <p class="modal-intro">
              Preencha os dados abaixo. Se a ferramenta pedir domínio, use um subdomínio apontado para o IP <strong>${escapeHtml(ip)}</strong>.
            </p>

            ${(a.fields || []).map(f => `
              <div class="form-group">
                <label>${escapeHtml(f.label)}</label>
                <input data-field-key="${f.key}" type="text" placeholder="${f.key === 'domain' ? 'Ex: zap.meusite.com' : ''}" value="${escapeHtml(state.appForm[f.key] || '')}" />
                ${f.key === 'domain' ? `<span class="field-hint">Aponte o Registro A de <strong>${escapeHtml(state.appForm.domain || "subdominio")}</strong> para <strong>${escapeHtml(ip)}</strong>.</span>` : ''}
              </div>
            `).join("")}

            ${state.cfConfigured && a.fields?.some(f => f.key === 'domain') ? `
              <div class="cf-auto-check">
                <label>
                  <input type="checkbox" id="cf-auto-create" checked />
                  ☁️ Criar registro DNS na Cloudflare automaticamente
                </label>
              </div>
            ` : ""}

            <div class="modal-actions">
              <button class="btn-primary full" id="btn-submit-app" type="button">
                Instalar Agora 🚀
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
            <h3>🔑 Credenciais de Acesso</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              Guarde essas informações em local seguro. Elas são necessárias para acessar e conectar sua ferramenta.
            </p>

            <div class="creds-terminal">
              <pre>${escapeHtml(data.creds)}</pre>
            </div>

            <div class="modal-actions">
              <button class="btn-primary full" onclick="navigator.clipboard.writeText(${JSON.stringify(data.creds)}); alert('Credenciais copiadas com sucesso!')">
                📋 Copiar Todas as Credenciais
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Modal 4: Cloudflare DNS Automation
  function renderCloudflareModal() {
    return `
      <div class="modal-backdrop">
        <div class="modal-box">
          <div class="modal-head">
            <h3>☁️ Conectar Cloudflare DNS</h3>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">
              Conecte seu <strong>Token de API da Cloudflare</strong> para que o SetupImpa crie os endereços (registros A) para você de forma 100% automática!
            </p>

            <div class="instruction-box">
              <strong>Como gerar seu Token na Cloudflare:</strong>
              <ol style="margin: 0.5rem 0 0 1.2rem; padding: 0; font-size: 0.88rem; line-height: 1.5;">
                <li>Acesse <strong>Cloudflare → Perfil → API Tokens → Create Token</strong></li>
                <li>Escolha <strong>Create Custom Token</strong></li>
                <li>Permissões: <strong>Zone:DNS (Edit)</strong> e <strong>Zone:Zone (Read)</strong></li>
                <li>Copie o token gerado e cole abaixo.</li>
              </ol>
            </div>

            <div class="form-group">
              <label>API Token da Cloudflare</label>
              <input id="cf-token-input" type="password" placeholder="Cole seu token da Cloudflare aqui..." />
              ${state.cfConfigured ? '<span class="field-hint green">✔ Token atualmente configurado e ativo.</span>' : ''}
            </div>

            <div class="modal-actions">
              <button class="btn-primary full" id="btn-save-cf-token" type="button">
                Validar e Salvar Token ➜
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  window.__closeModal = closeModal;

  // Bind modal dynamic actions
  document.addEventListener("click", async (e) => {
    // Fechar modal clicando fora
    if (e.target.classList.contains("modal-backdrop")) {
      closeModal();
    }

    // Salvar Base
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
        toast("Iniciando configuração da base... aguarde alguns instantes.", "info");
        const res = await api("/api/install/base", { method: "POST", body: JSON.stringify(state.baseForm) });
        if (!res.ok) throw new Error(res.error || "Falha na instalação.");

        // Se tem Cloudflare, tenta criar automático
        if (state.cfConfigured) {
          try {
            await api("/api/cloudflare/dns", { method: "POST", body: JSON.stringify({ domain }) });
            toast("Registro DNS criado na Cloudflare automaticamente!", "ok");
          } catch (_) {}
        }

        // Tenta finalizar após DNS
        toast("Finalizando configuração do servidor...", "info");
        const fin = await api("/api/install/base/finish", { method: "POST", body: JSON.stringify({ confirm_cloudflare: true }) });
        closeModal();
        await loadApps();
        toast("Servidor ativado com sucesso!", "ok");
        render();
      } catch (err) {
        toast("Erro ao ativar servidor: " + err.message, "err");
      }
    }

    // Salvar App
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

    // Salvar CF Token
    if (e.target.id === "btn-save-cf-token") {
      const token = (document.getElementById("cf-token-input")?.value || "").trim();
      if (!token) return toast("Cole o token da Cloudflare.", "err");
      try {
        toast("Verificando token na Cloudflare...", "info");
        const res = await api("/api/cloudflare/token", { method: "POST", body: JSON.stringify({ token }) });
        state.cfConfigured = true;
        toast("Token da Cloudflare conectado e verificado com sucesso!", "ok");
        closeModal();
      } catch (err) {
        toast("Token inválido na Cloudflare: " + err.message, "err");
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
        state.expandedApp = appMeta.id;
        await loadApps();
        render();
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    toast("Tempo limite excedido aguardando o container subir.", "err");
  }

  // ── Router Principal ──────────────────────────────────────────
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
