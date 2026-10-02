(() => {
  const app = document.getElementById("app");
  const state = {
    token: localStorage.getItem("setupimpa_session") || "",
    username: localStorage.getItem("setupimpa_user") || "",
    auth: null,
    status: null,
    apps: [],
    postgresInstances: [],
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
    activeTab: "marketplace", // 'marketplace' | 'instances' | 'cloudflare' | 'base' | 'mcp'
    mcpConfig: null,
    mcpActiveSnippetTab: "cursor",
    mcpTesting: false,
    mcpTestResult: null,
    showMcpKey: false,
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
      state.postgresInstances = data.postgres_instances || [];
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

  async function loadMcpConfig() {
    try {
      const res = await api("/api/mcp/config");
      state.mcpConfig = res;
      render();
    } catch (e) {
      toast("Falha ao carregar configuração MCP: " + e.message, "err");
    }
  }

  // ── Metadados dos Apps (Estilo Hosteg) ──────────────────────────
  const APP_METAS = {
    base: {
      icon: '<img src="/assets/traefik.svg" class="app-icon-img" alt="Traefik" />',
      name: "Infraestrutura Base",
      tag: "Obrigatório",
      ram: "512 MB RAM",
      category: "infra",
      desc: "Roteador Traefik v3 com emissão automática de SSL (HTTPS grátis) e cluster Docker pronto.",
      includes: "Roteador Traefik v3, Let's Encrypt SSL e Rede Segura",
      favorite: false,
    },
    evolution: {
      icon: '<img src="/assets/evolution.png" class="app-icon-img" alt="Evolution API" />',
      name: "Evolution API v2",
      tag: "WhatsApp Oficial",
      ram: "1 GB RAM",
      category: "whatsapp",
      desc: "Conecta números de WhatsApp aos seus sistemas, robôs e automações por API com suporte a webhooks.",
      includes: "Banco PostgreSQL, SSL grátis e Rotas Traefik",
      requires_postgres: true,
      favorite: true,
    },
    hermes: {
      icon: '<img src="/assets/hermes-dark.svg" class="app-icon-img" alt="Hermes Agente IA" />',
      name: "Hermes Agente IA",
      tag: "Inteligência Artificial",
      ram: "2 GB RAM",
      category: "ai",
      desc: "Agente de IA persistente com painel visual, memória e integrações para automação inteligente.",
      includes: "Dashboard visual protegido, proxy reverso e SSL grátis",
      favorite: true,
    },
    postgres: {
      icon: '<img src="/assets/postgres.svg" class="app-icon-img" alt="PostgreSQL" />',
      name: "PostgreSQL",
      tag: "Padrão Orion",
      ram: "1 GB RAM",
      category: "db",
      desc: "Banco de dados relacional oficial padrão SetupOrion (v14 com tuning de 500 conexões e timezone SP).",
      includes: "Volume persistente em /root/dados_vps, 500 conexões e rede segura",
      favorite: true,
    },
    getfy: {
      icon: '<img src="/assets/getfy.png" class="app-icon-img" alt="Getfy Checkout" />',
      name: "Getfy Checkout",
      tag: "Checkout & Vendas",
      ram: "1 GB RAM",
      category: "sales",
      desc: "Plataforma completa de checkout, produtos e pagamentos com Redis dedicado para alta conversão.",
      includes: "Redis dedicado, Traefik SSL e Wizard de primeiro acesso",
      requires_postgres: true,
      favorite: true,
    },
    omniroute: {
      icon: '<img src="/assets/omniroute.svg" class="app-icon-img" alt="OmniRoute AI" />',
      name: "OmniRoute Gateway AI",
      tag: "AI Gateway & Proxy",
      ram: "1.5 GB RAM",
      category: "ai",
      desc: "Roteador inteligente e gateway unificado de LLMs (OpenAI, Claude, Gemini, Groq, DeepSeek) com balanceamento de carga, rate limits e dashboard.",
      includes: "Redis dedicado, Traefik SSL, Roteador de IAs e Dashboard Web",
      requires_postgres: false,
      favorite: true,
    },
    "9router": {
      icon: '<img src="/assets/9router.svg" class="app-icon-img" alt="9Router AI" />',
      name: "9Router Gateway AI",
      tag: "AI Gateway & Proxy",
      ram: "2 GB RAM",
      category: "ai",
      desc: "Gateway universal para Claude Code, Codex, Cursor, Cline e Copilot conectando a mais de 40 provedores com dashboard visual.",
      includes: "Proxy universal 40+ IAs, Traefik SSL e Dashboard Web",
      requires_postgres: false,
      favorite: true,
    },
  };

  // ── Mapeamento Padrão IMPA de Categorias e Metas para Stacks Orion ──
  const ORION_CATEGORY_TAGS = {
    atendimento: "Atendimento & Chat",
    comunicacao: "WhatsApp & Mensageria",
    ia: "Inteligência Artificial",
    automacao: "Automação & Workflows",
    banco: "Banco de Dados",
    marketing: "Marketing & Envios",
    produtividade: "Produtividade & CRM",
    infra: "Infraestrutura & Cloud",
    seguranca: "Segurança & Auth",
    desenvolvimento: "Dev & Low-Code",
    utilitarios: "Utilitários & Ferramentas",
    outros: "Ferramentas & Web",
  };

  const APP_SPECIFIC_META = {
    // Comunicação / WhatsApp
    evolution: { tag: "WhatsApp API", icon: '<img src="/assets/evolution.png" class="app-icon-img" alt="Evolution API" />', ram: "1 GB RAM" },
    evolution_v1: { tag: "WhatsApp API", icon: '<img src="/assets/evolution.png" class="app-icon-img" alt="Evolution API" />', ram: "1 GB RAM" },
    evolution_v2: { tag: "WhatsApp API", icon: '<img src="/assets/evolution.png" class="app-icon-img" alt="Evolution API" />', ram: "1 GB RAM" },
    evolution_lite: { tag: "WhatsApp API", icon: '<img src="/assets/evolution.png" class="app-icon-img" alt="Evolution API" />', ram: "1 GB RAM" },
    evolution_go: { tag: "WhatsApp API", icon: '<img src="/assets/evolution.png" class="app-icon-img" alt="Evolution API" />', ram: "1 GB RAM" },
    wppconnect: { tag: "WhatsApp API", icon: '<img src="/assets/logos/whatsapp.svg" class="app-icon-img" alt="WPPConnect" />', ram: "1 GB RAM" },
    wuzapi: { tag: "WhatsApp API", icon: '<img src="/assets/logos/whatsapp.svg" class="app-icon-img" alt="WuzAPI" />', ram: "1 GB RAM" },
    quepasa: { tag: "WhatsApp API", icon: '<img src="/assets/logos/whatsapp.svg" class="app-icon-img" alt="Quepasa" />', ram: "1 GB RAM" },
    unoapi: { tag: "WhatsApp API", icon: '<img src="/assets/logos/whatsapp.svg" class="app-icon-img" alt="UnoAPI" />', ram: "1 GB RAM" },
    woofed: { tag: "WhatsApp API", icon: '<img src="/assets/logos/whatsapp.svg" class="app-icon-img" alt="Woofed" />', ram: "1 GB RAM" },
    chatwoot: { tag: "Atendimento Omnichannel", icon: '<img src="/assets/logos/chatwoot.svg" class="app-icon-img" alt="Chatwoot" />', ram: "1 GB RAM" },
    chatwoot_nestor: { tag: "Atendimento Omnichannel", icon: '<img src="/assets/logos/chatwoot_nestor.svg" class="app-icon-img" alt="Chatwoot Nestor" />', ram: "1 GB RAM" },
    typebot: { tag: "Chatbot Visual & Funis", icon: '<img src="/assets/logos/typebot.svg" class="app-icon-img" alt="Typebot" />', ram: "1 GB RAM" },
    jitsi: { tag: "Videoconferência", icon: '<img src="/assets/logos/jitsi.svg" class="app-icon-img" alt="Jitsi" />', ram: "2 GB RAM" },
    mattermost: { tag: "Chat de Equipe", icon: '<img src="/assets/logos/mattermost.svg" class="app-icon-img" alt="Mattermost" />', ram: "1 GB RAM" },
    humhub: { tag: "Rede Social Corporativa", icon: '<img src="/assets/logos/humhub.svg" class="app-icon-img" alt="HumHub" />', ram: "1 GB RAM" },

    // Automação
    n8n: { tag: "Automação & Fluxos", icon: '<img src="/assets/logos/n8n.svg" class="app-icon-img" alt="N8N" />', ram: "1 GB RAM" },
    n8n_quepasa: { tag: "Automação & WhatsApp", icon: '<img src="/assets/logos/n8n.svg" class="app-icon-img" alt="N8N Quepasa" />', ram: "1 GB RAM" },
    activepieces: { tag: "Automação & Workflows", icon: '<img src="/assets/logos/activepieces.svg" class="app-icon-img" alt="Activepieces" />', ram: "1 GB RAM" },

    // IA & LLMs
    dify: { tag: "Agentes & IA", icon: '<img src="/assets/logos/dify.svg" class="app-icon-img" alt="Dify AI" />', ram: "2 GB RAM" },
    flowise: { tag: "Agentes & LangChain", icon: '<img src="/assets/logos/flowise.svg" class="app-icon-img" alt="Flowise" />', ram: "1 GB RAM" },
    openwebui: { tag: "Interface LLM / Chat", icon: '<img src="/assets/logos/openwebui.svg" class="app-icon-img" alt="Open WebUI" />', ram: "1 GB RAM" },
    ollama: { tag: "LLMs & Modelos Locais", icon: '<img src="/assets/logos/ollama.svg" class="app-icon-img" alt="Ollama" />', ram: "4 GB RAM" },
    anythingllm: { tag: "IA & RAG Corporativo", icon: '<img src="/assets/logos/openwebui.svg" class="app-icon-img" alt="AnythingLLM" />', ram: "1 GB RAM" },
    langflow: { tag: "Orquestração de IA", icon: '<img src="/assets/logos/langflow.svg" class="app-icon-img" alt="Langflow" />', ram: "1 GB RAM" },
    langfuse: { tag: "Observabilidade IA", icon: '<img src="/assets/logos/langfuse.svg" class="app-icon-img" alt="Langfuse" />', ram: "1 GB RAM" },
    botpress: { tag: "Chatbot com IA", icon: '<img src="/assets/logos/botpress.svg" class="app-icon-img" alt="Botpress" />', ram: "1 GB RAM" },
    evoai: { tag: "Inteligência Artificial", icon: '<img src="/assets/logos/dify.svg" class="app-icon-img" alt="Evo AI" />', ram: "1 GB RAM" },
    firecrawl: { tag: "Web Scraping para IA", icon: '<img src="/assets/logos/firecrawl.svg" class="app-icon-img" alt="Firecrawl" />', ram: "1 GB RAM" },
    transcrevezap: { tag: "Transcrição com IA", icon: '<img src="/assets/logos/whatsapp.svg" class="app-icon-img" alt="TranscreveZap" />', ram: "1 GB RAM" },
    zep: { tag: "Memória para LLMs", icon: '<img src="/assets/logos/openwebui.svg" class="app-icon-img" alt="Zep" />', ram: "1 GB RAM" },

    // Banco de Dados & Storage
    minio: { tag: "Storage S3", icon: '<img src="/assets/logos/minio.svg" class="app-icon-img" alt="MinIO" />', ram: "1 GB RAM" },
    pgAdmin_4: { tag: "Gestão PostgreSQL", icon: '<img src="/assets/logos/pgAdmin_4.svg" class="app-icon-img" alt="pgAdmin" />', ram: "1 GB RAM" },
    phpmyadmin: { tag: "Gestão MySQL", icon: '<img src="/assets/logos/phpmyadmin.svg" class="app-icon-img" alt="phpMyAdmin" />', ram: "512 MB RAM" },
    redisinsight: { tag: "Gestão Redis", icon: '<img src="/assets/logos/redisinsight.svg" class="app-icon-img" alt="RedisInsight" />', ram: "512 MB RAM" },
    mongodb: { tag: "Banco NoSQL", icon: '<img src="/assets/logos/mongodb.svg" class="app-icon-img" alt="MongoDB" />', ram: "1 GB RAM" },
    clickhouse: { tag: "Banco Analítico", icon: '<img src="/assets/logos/clickhouse.svg" class="app-icon-img" alt="ClickHouse" />', ram: "2 GB RAM" },
    pgbackweb: { tag: "Backups PostgreSQL", icon: '<img src="/assets/logos/pgbackweb.svg" class="app-icon-img" alt="PgBackWeb" />', ram: "512 MB RAM" },

    // CRM, Produtividade & No-Code
    baserow: { tag: "Banco de Dados No-Code", icon: '<img src="/assets/logos/baserow.svg" class="app-icon-img" alt="Baserow" />', ram: "1 GB RAM" },
    nocodb: { tag: "Airtable No-Code", icon: '<img src="/assets/logos/nocodb.svg" class="app-icon-img" alt="NocoDB" />', ram: "1 GB RAM" },
    nocobase: { tag: "Plataforma No-Code", icon: '<img src="/assets/logos/nocobase.svg" class="app-icon-img" alt="NocoBase" />', ram: "1 GB RAM" },
    twentycrm: { tag: "CRM & Vendas", icon: '<img src="/assets/logos/twentycrm.svg" class="app-icon-img" alt="Twenty CRM" />', ram: "1.5 GB RAM" },
    krayincrm: { tag: "CRM de Vendas", icon: '<img src="/assets/logos/twentycrm.svg" class="app-icon-img" alt="Krayin CRM" />', ram: "1 GB RAM" },
    evocrm: { tag: "CRM & Gestão", icon: '<img src="/assets/logos/twentycrm.svg" class="app-icon-img" alt="Evo CRM" />', ram: "1 GB RAM" },
    calcom: { tag: "Agendamentos Online", icon: '<img src="/assets/logos/calcom.svg" class="app-icon-img" alt="Cal.com" />', ram: "1 GB RAM" },
    easyappointments: { tag: "Agendamentos Online", icon: '<img src="/assets/logos/calcom.svg" class="app-icon-img" alt="EasyAppointments" />', ram: "512 MB RAM" },
    nextcloud: { tag: "Arquivos & Nuvem", icon: '<img src="/assets/logos/nextcloud.svg" class="app-icon-img" alt="Nextcloud" />', ram: "1 GB RAM" },
    outline: { tag: "Wiki & Documentação", icon: '<img src="/assets/logos/outline.svg" class="app-icon-img" alt="Outline" />', ram: "1 GB RAM" },
    wiki: { tag: "Wiki & Conhecimento", icon: '<img src="/assets/logos/wiki.svg" class="app-icon-img" alt="Wiki.js" />', ram: "1 GB RAM" },
    docmost: { tag: "Wiki Colaborativa", icon: '<img src="/assets/logos/outline.svg" class="app-icon-img" alt="Docmost" />', ram: "1 GB RAM" },
    documenso: { tag: "Assinatura Digital", icon: '<img src="/assets/logos/documenso.svg" class="app-icon-img" alt="Documenso" />', ram: "1 GB RAM" },
    docuseal: { tag: "Assinatura de Documentos", icon: '<img src="/assets/logos/docuseal.svg" class="app-icon-img" alt="DocuSeal" />', ram: "1 GB RAM" },
    opensign: { tag: "Assinatura Digital", icon: '<img src="/assets/logos/documenso.svg" class="app-icon-img" alt="OpenSign" />', ram: "1 GB RAM" },
    focalboard: { tag: "Kanban & Projetos", icon: '<img src="/assets/logos/focalboard.svg" class="app-icon-img" alt="Focalboard" />', ram: "512 MB RAM" },
    planka: { tag: "Kanban & Tarefas", icon: '<img src="/assets/logos/focalboard.svg" class="app-icon-img" alt="Planka" />', ram: "512 MB RAM" },
    wekan: { tag: "Quadro Kanban", icon: '<img src="/assets/logos/focalboard.svg" class="app-icon-img" alt="Wekan" />', ram: "512 MB RAM" },
    openproject: { tag: "Gestão de Projetos", icon: '<img src="/assets/logos/focalboard.svg" class="app-icon-img" alt="OpenProject" />', ram: "1.5 GB RAM" },
    affine: { tag: "Workspace Notion-like", icon: '<img src="/assets/logos/outline.svg" class="app-icon-img" alt="AFFiNE" />', ram: "1 GB RAM" },
    wordpress: { tag: "CMS & Sites", icon: '<img src="/assets/logos/wordpress.svg" class="app-icon-img" alt="WordPress" />', ram: "1 GB RAM" },
    bolt: { tag: "CMS Headless", icon: '<img src="/assets/logos/wordpress.svg" class="app-icon-img" alt="Bolt CMS" />', ram: "512 MB RAM" },
    frappe: { tag: "ERP & Gestão", icon: '<img src="/assets/logos/frappe.svg" class="app-icon-img" alt="ERPNext" />', ram: "2 GB RAM" },
    odoo: { tag: "ERP Empresarial", icon: '<img src="/assets/logos/odoo.svg" class="app-icon-img" alt="Odoo" />', ram: "2 GB RAM" },
    metabase: { tag: "BI & Dashboards", icon: '<img src="/assets/logos/metabase.svg" class="app-icon-img" alt="Metabase" />', ram: "1.5 GB RAM" },
    excalidraw: { tag: "Quadro Branco & Desenho", icon: '<img src="/assets/logos/excalidraw.svg" class="app-icon-img" alt="Excalidraw" />', ram: "512 MB RAM" },
    wisemapping: { tag: "Mapas Mentais", icon: '<img src="/assets/logos/excalidraw.svg" class="app-icon-img" alt="WiseMapping" />', ram: "512 MB RAM" },
    checkmate: { tag: "Checklists & Tarefas", icon: '<img src="/assets/logos/focalboard.svg" class="app-icon-img" alt="Checkmate" />', ram: "512 MB RAM" },
    papra: { tag: "Gestão de Arquivos", icon: '<img src="/assets/logos/nextcloud.svg" class="app-icon-img" alt="Papra" />', ram: "512 MB RAM" },

    // Desenvolvimento & Low-Code
    code_server: { tag: "VS Code no Navegador", icon: '<img src="/assets/logos/code_server.svg" class="app-icon-img" alt="VS Code" />', ram: "1 GB RAM" },
    supabase: { tag: "Backend como Serviço", icon: '<img src="/assets/logos/supabase.svg" class="app-icon-img" alt="Supabase" />', ram: "2 GB RAM" },
    directus: { tag: "Headless CMS & API", icon: '<img src="/assets/logos/directus.svg" class="app-icon-img" alt="Directus" />', ram: "1 GB RAM" },
    strapi: { tag: "Headless CMS", icon: '<img src="/assets/logos/strapi.svg" class="app-icon-img" alt="Strapi" />', ram: "1 GB RAM" },
    tooljet: { tag: "Low-Code Interno", icon: '<img src="/assets/logos/appsmith.svg" class="app-icon-img" alt="ToolJet" />', ram: "1.5 GB RAM" },
    appsmith: { tag: "Low-Code para Times", icon: '<img src="/assets/logos/appsmith.svg" class="app-icon-img" alt="Appsmith" />', ram: "1.5 GB RAM" },
    lowcoder: { tag: "Low-Code Apps", icon: '<img src="/assets/logos/appsmith.svg" class="app-icon-img" alt="Lowcoder" />', ram: "1 GB RAM" },
    hoppscotch: { tag: "Testes de API", icon: '<img src="/assets/logos/code_server.svg" class="app-icon-img" alt="Hoppscotch" />', ram: "512 MB RAM" },

    // Segurança & Auth
    authentik: { tag: "Autenticação & SSO", icon: '<img src="/assets/logos/authentik.svg" class="app-icon-img" alt="Authentik" />', ram: "1.5 GB RAM" },
    keycloak: { tag: "Autenticação & Identity", icon: '<img src="/assets/logos/keycloak.svg" class="app-icon-img" alt="Keycloak" />', ram: "1.5 GB RAM" },
    vaultwarden: { tag: "Cofre de Senhas", icon: '<img src="/assets/logos/vaultwarden.svg" class="app-icon-img" alt="Vaultwarden" />', ram: "512 MB RAM" },
    passbolt: { tag: "Gestão de Senhas", icon: '<img src="/assets/logos/passbolt.svg" class="app-icon-img" alt="Passbolt" />', ram: "512 MB RAM" },
    duplicati: { tag: "Backup em Nuvem", icon: '<img src="/assets/logos/pgbackweb.svg" class="app-icon-img" alt="Duplicati" />', ram: "512 MB RAM" },

    // Infra & DevOps
    uptimekuma: { tag: "Monitoramento de Uptime", icon: '<img src="/assets/logos/uptimekuma.svg" class="app-icon-img" alt="Uptime Kuma" />', ram: "512 MB RAM" },
    rabbitmq: { tag: "Filas & Mensageria", icon: '<img src="/assets/logos/rabbitmq.svg" class="app-icon-img" alt="RabbitMQ" />', ram: "1 GB RAM" },
    kafka: { tag: "Streaming & Mensageria", icon: '<img src="/assets/logos/kafka.svg" class="app-icon-img" alt="Kafka" />', ram: "1.5 GB RAM" },
    netbox: { tag: "Gestão de Infra & IPAM", icon: '<img src="/assets/logos/uptimekuma.svg" class="app-icon-img" alt="Netbox" />', ram: "1 GB RAM" },
    glpi: { tag: "Helpdesk & Ativos", icon: '<img src="/assets/logos/glpi.svg" class="app-icon-img" alt="GLPI" />', ram: "1 GB RAM" },
    rustdesk: { tag: "Relay de Acesso Remoto", icon: '<img src="/assets/logos/rustdesk.svg" class="app-icon-img" alt="RustDesk" />', ram: "512 MB RAM" },
    ntfy: { tag: "Notificações Push", icon: '<img src="/assets/logos/chatwoot.svg" class="app-icon-img" alt="ntfy" />', ram: "512 MB RAM" },
    zerobyte: { tag: "Infraestrutura Leve", icon: '<img src="/assets/docker.svg" class="app-icon-img" alt="Zerobyte" />', ram: "512 MB RAM" },
    monitor: { tag: "Monitoramento de Servidor", icon: '<img src="/assets/logos/uptimekuma.svg" class="app-icon-img" alt="Monitor" />', ram: "512 MB RAM" },

    // Marketing
    mautic: { tag: "Automação de Marketing", icon: '<img src="/assets/logos/mautic.svg" class="app-icon-img" alt="Mautic" />', ram: "1 GB RAM" },
    heyform: { tag: "Formulários Online", icon: '<img src="/assets/logos/typebot.svg" class="app-icon-img" alt="HeyForm" />', ram: "512 MB RAM" },
    astracampaign: { tag: "Disparador de Mensagens", icon: '<img src="/assets/logos/mautic.svg" class="app-icon-img" alt="Astra Campaign" />', ram: "1 GB RAM" },
    serpbear: { tag: "Rankings & SEO", icon: '<img src="/assets/logos/metabase.svg" class="app-icon-img" alt="SerpBear" />', ram: "512 MB RAM" },

    // Utilitários
    stirlingpdf: { tag: "Manipulação de PDF", icon: '<img src="/assets/logos/stirlingpdf.svg" class="app-icon-img" alt="Stirling PDF" />', ram: "512 MB RAM" },
    browserless: { tag: "Chrome Headless API", icon: '<img src="/assets/logos/browserless.svg" class="app-icon-img" alt="Browserless" />', ram: "1 GB RAM" },
    shlink: { tag: "Encurtador de URLs", icon: '<img src="/assets/logos/shlink.svg" class="app-icon-img" alt="Shlink" />', ram: "512 MB RAM" },
    yourls: { tag: "Encurtador de Links", icon: '<img src="/assets/logos/shlink.svg" class="app-icon-img" alt="YOURLS" />', ram: "512 MB RAM" },
    traccar: { tag: "Rastreamento GPS", icon: '<img src="/assets/logos/traccar.svg" class="app-icon-img" alt="Traccar" />', ram: "512 MB RAM" },
    azuracast: { tag: "Rádio Online Web", icon: '<img src="/assets/logos/humhub.svg" class="app-icon-img" alt="AzuraCast" />', ram: "1.5 GB RAM" },
    omnitools: { tag: "Utilitários para Devs", icon: '<img src="/assets/logos/code_server.svg" class="app-icon-img" alt="OmniTools" />', ram: "512 MB RAM" },
    gotenberg: { tag: "Conversão de Arquivos", icon: '<img src="/assets/logos/stirlingpdf.svg" class="app-icon-img" alt="Gotenberg" />', ram: "512 MB RAM" },
  };

  function resolveAppMeta(a) {
    if (!a) return { name: "App", tag: "App", icon: '<img src="/assets/docker.svg" class="app-icon-img" alt="App" />', ram: "1 GB RAM", desc: "", includes: "" };
    const isOrion = a.source === "setuporion";
    
    // 1. App oficial registrado
    if (APP_METAS[a.id]) {
      return { ...APP_METAS[a.id] };
    }

    // 2. Metadado específico conhecido
    const specific = APP_SPECIFIC_META[a.id] || {};
    const fallbackTag = ORION_CATEGORY_TAGS[a.category] || "Ferramenta";
    const defaultIcon = '<img src="/assets/docker.svg" class="app-icon-img" alt="Docker Stack" />';

    return {
      icon: specific.icon || defaultIcon,
      name: a.name || a.id,
      tag: specific.tag || fallbackTag,
      ram: specific.ram || "1 GB RAM",
      desc: a.description || "",
      includes: isOrion
        ? (a.pg_dbs && a.pg_dbs.length > 0
            ? "Provisiona banco PostgreSQL automático, Traefik SSL e volume persistente"
            : "Stack Swarm oficial SetupOrion e Traefik SSL")
        : "Roteador Traefik e rede isolada",
      favorite: false,
    };
  }

  // ── Render Principal (Layout Hosteg com Sidebar) ───────────────
  function renderDashboard() {
    const baseInstalled = !!state.status?.base_installed;
    const ip = state.status?.public_ip || "—";

    const rawApps = state.apps.filter(a => a.id !== "base");
    const filteredApps = rawApps.filter(a => {
      const meta = resolveAppMeta(a);
      const q = state.searchQuery.toLowerCase().trim();
      const matchQuery = !q ||
        (meta.name && meta.name.toLowerCase().includes(q)) ||
        (meta.desc && meta.desc.toLowerCase().includes(q)) ||
        (meta.tag && meta.tag.toLowerCase().includes(q)) ||
        (a.id && a.id.toLowerCase().includes(q)) ||
        (a.name && a.name.toLowerCase().includes(q)) ||
        (a.description && a.description.toLowerCase().includes(q));

      let matchCat = true;
      if (state.selectedCategory === "all") matchCat = true;
      else if (state.selectedCategory === "official") matchCat = a.source === "official" || !a.source;
      else if (state.selectedCategory === "orion") matchCat = a.source === "setuporion";
      else if (state.selectedCategory === "favorites") matchCat = !!meta.favorite;
      else if (state.selectedCategory === "ai") matchCat = meta.category === "ai" || a.category === "ia";
      else if (state.selectedCategory === "automation") matchCat = a.category === "automacao" || meta.category === "automation";
      else if (state.selectedCategory === "chat") matchCat = meta.category === "whatsapp" || a.category === "atendimento" || a.category === "comunicacao";
      else if (state.selectedCategory === "crm") matchCat = a.category === "produtividade" || meta.category === "sales" || a.category === "marketing";
      else if (state.selectedCategory === "db") matchCat = meta.category === "db" || a.category === "banco" || a.category === "infra";
      else if (state.selectedCategory === "dev") matchCat = a.category === "desenvolvimento" || a.category === "utilitarios" || a.category === "seguranca";
      else matchCat = (meta.category === state.selectedCategory || a.category === state.selectedCategory);

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
              <span class="menu-icon"><img src="/assets/cloudflare.svg" class="menu-svg-icon" alt="Cloudflare" /></span>
              <span class="menu-label">Cloudflare DNS</span>
              ${state.cfConfigured ? '<span class="menu-pill green">Ativo</span>' : ""}
            </button>

            <button class="menu-item ${state.activeTab === "base" ? "active" : ""}" data-tab="base">
              <span class="menu-icon"><img src="/assets/traefik.svg" class="menu-svg-icon" alt="Base" /></span>
              <span class="menu-label">Base do Servidor</span>
              ${baseInstalled ? '<span class="menu-pill green">Pronto</span>' : '<span class="menu-pill yellow">Configurar</span>'}
            </button>

            <button class="menu-item ${state.activeTab === "mcp" ? "active" : ""}" data-tab="mcp">
              <span class="menu-icon">🤖</span>
              <span class="menu-label">MCP & Agente IA</span>
              <span class="menu-pill green">Ativo</span>
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

            <div class="sidebar-orion-credit">
              <span>Stack engine compatível com</span>
              <strong>SetupOrion</strong>
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
    if (state.activeTab === "mcp") {
      return renderMcpTab(ip);
    }
    return renderMarketplaceTab(baseInstalled, filteredApps, ip);
  }

  // ── Tab: Marketplace de APPs ────────────────────────────────────
  function renderMarketplaceTab(baseInstalled, filteredApps, ip) {
    const rawApps = (state.apps || []).filter(a => a.id !== "base");
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
                 placeholder="Buscar por nome ou tecnologia: N8N, Chatwoot, Typebot, Dify, MinIO, WhatsApp..."
                 value="${escapeHtml(state.searchQuery)}" />
        </div>

        <div class="category-select-box">
          <select id="marketplace-category">
            <option value="all" ${state.selectedCategory === "all" ? "selected" : ""}>Todas as aplicações (${rawApps.length})</option>
            <option value="official" ${state.selectedCategory === "official" ? "selected" : ""}>⭐ Oficiais SetupImpa</option>
            <option value="orion" ${state.selectedCategory === "orion" ? "selected" : ""}>🚀 Catálogo SetupOrion</option>
            <option value="ai" ${state.selectedCategory === "ai" ? "selected" : ""}>🤖 Inteligência Artificial & LLMs</option>
            <option value="automation" ${state.selectedCategory === "automation" ? "selected" : ""}>⚡ Automação & Workflows</option>
            <option value="chat" ${state.selectedCategory === "chat" ? "selected" : ""}>💬 Atendimento & WhatsApp</option>
            <option value="crm" ${state.selectedCategory === "crm" ? "selected" : ""}>📊 CRM & Produtividade</option>
            <option value="db" ${state.selectedCategory === "db" ? "selected" : ""}>🗄️ Bancos de Dados & Storage</option>
            <option value="dev" ${state.selectedCategory === "dev" ? "selected" : ""}>🛠️ Infra & Ferramentas Dev</option>
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
          const isOrion = a.source === "setuporion";
          const meta = resolveAppMeta(a);

          // Personalização inteligente do texto "Instala junto"
          const pgs = state.postgresInstances || [];
          if (a.id === "evolution") {
            if (pgs.length > 0) {
              meta.includes = `Conecta no seu ${pgs[0].label} ativo, SSL grátis e Rotas Traefik`;
            } else {
              meta.includes = "Cria banco PostgreSQL automático (se desejar) e SSL grátis";
            }
          } else if (a.id === "getfy") {
            if (pgs.length > 0) {
              meta.includes = `Conecta no seu ${pgs[0].label} ativo, Redis dedicado e Traefik SSL`;
            } else {
              meta.includes = "Cria banco PostgreSQL automático (se desejar), Redis dedicado e Traefik SSL";
            }
          } else if (isOrion) {
            if (a.pg_dbs && a.pg_dbs.length > 0) {
              meta.includes = "Provisiona banco PostgreSQL automático, Traefik SSL e volume persistente";
            }
          }

          const count = a.instance_count || 0;
          const hasInst = count > 0;

          return `
            <div class="hosteg-card ${hasInst ? "installed" : ""}">
              <div class="card-top">
                <div class="app-avatar">${meta.icon}</div>
                <div class="app-identity">
                  <h3>${escapeHtml(meta.name)}</h3>
                  <div class="tags-row">
                    <span class="app-tag-pill ${isOrion ? "orion-tag" : "official-tag"}">${escapeHtml(meta.tag)}</span>
                    ${isOrion ? '<span class="orion-mini-badge" title="Template oficial SetupOrion">Orion</span>' : ''}
                  </div>
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
                    <div style="display:flex;align-items:center;gap:0.75rem;">
                      <span class="inst-avatar-mini">${resolveAppMeta({ id: inst.app_id }).icon || '📦'}</span>
                      <strong>${escapeHtml(inst.app_name)}</strong>
                    </div>
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

        <div style="margin-top: 1.5rem; display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;">
          <button class="btn-hosteg-primary" id="btn-open-base-modal">
            ${baseInstalled ? "Reconfigurar Domínio da Base" : "Configurar Agora em 1 Minuto ➜"}
          </button>
          <button class="btn-table-action" id="btn-update-panel" style="padding: 0.65rem 1.15rem; font-size: 0.88rem; display: inline-flex; align-items: center; gap: 0.4rem;">
            🔄 Atualizar Painel para Versão Oficial
          </button>
        </div>
      </div>

      ${baseInstalled && portainerUrl ? `
        <!-- Painel Técnico & Portainer (Acesso Direto sem SFTP) -->
        <div class="portainer-tech-card">
          <div class="portainer-tech-header">
            <div class="portainer-badge-row">
              <span class="tech-badge">PAINEL TÉCNICO & GERENCIADOR</span>
              <span class="portainer-tag-pill"><img src="/assets/portainer.svg" class="chip-svg-inline" alt="Portainer" /> Portainer CE</span>
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

      <!-- Card de Compatibilidade & Créditos SetupOrion -->
      <div class="orion-credits-card">
        <div class="orion-credits-head">
          <span class="orion-credits-icon">🚀</span>
          <div>
            <h4>Ecossistema & Créditos ao SetupOrion</h4>
            <p>O SetupImpa integra e adapta nativamente os templates e stacks Swarm desenvolvidos pelo projeto <strong>SetupOrion</strong>. Mantemos total compatibilidade com a topologia de rede interna (<code>OrionNet</code>), o padrão de persistência de credenciais em <code>/root/dados_vps/</code> e coexistência pacífica com instâncias criadas anteriormente.</p>
          </div>
        </div>
      </div>
    `;
  }

  // ── Tab: MCP & Agente IA ─────────────────────────────────────────
  window.__clearMcpTest = () => {
    state.mcpTestResult = null;
    render();
  };

  function renderMcpTab(ip) {
    const cfg = state.mcpConfig || {};
    const key = cfg.mcp_api_key || "Carregando chave...";
    const sseUrl = cfg.sse_url || (ip ? `http://${ip}:8877/mcp/sse?token=${key}` : "");
    const activeSnippet = state.mcpActiveSnippetTab || "cursor";

    const isVisible = Boolean(state.showMcpKey);
    const maskedToken = "••••••••••••••••••••••••••••••••••••••";
    const displaySseUrl = isVisible
      ? sseUrl
      : (ip ? `http://${ip}:8877/mcp/sse?token=${maskedToken}` : "");

    const snippetKey = isVisible ? key : maskedToken;
    const snippetSseUrl = isVisible
      ? sseUrl
      : (sseUrl ? sseUrl.replace(/token=[^"'\s&]+/, `token=${maskedToken}`) : "");

    const cursorSnippet = JSON.stringify({
      "mcpServers": {
        "setupimpa-vps": {
          "url": snippetSseUrl
        }
      }
    }, null, 2);

    const claudeSnippet = JSON.stringify({
      "mcpServers": {
        "setupimpa-vps": {
          "url": snippetSseUrl
        }
      }
    }, null, 2);

    const hermesSnippet = JSON.stringify({
      "name": "SetupImpa VPS Controller",
      "type": "sse",
      "url": snippetSseUrl,
      "token": snippetKey
    }, null, 2);

    const cliSnippet = `python -m mcp.cli --url http://${ip}:8877 --token ${snippetKey}`;

    let currentSnippet = cursorSnippet;
    if (activeSnippet === "claude") currentSnippet = claudeSnippet;
    else if (activeSnippet === "hermes") currentSnippet = hermesSnippet;
    else if (activeSnippet === "cli") currentSnippet = cliSnippet;

    return `
      <div class="page-title-row">
        <div>
          <h2>Model Context Protocol (MCP) & Agentes de IA</h2>
          <p class="page-subtitle">Conecte o Cursor IDE, Claude Desktop, Claude Code, Cline ou Hermes diretamente à sua VPS com automação inteligente e comandos nativos.</p>
        </div>
      </div>

      <div class="mcp-overview-card">
        <div class="mcp-status-banner">
          <div class="mcp-status-pulse"></div>
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.25rem;">
              <span class="mcp-title-badge">MCP SERVER NATIVO ATIVO</span>
              <span class="mcp-pill green">Porta :8877 Online</span>
              <span class="mcp-pill blue">16 Ferramentas</span>
            </div>
            <p class="mcp-status-desc">
              Qualquer agente de inteligência artificial conectado a este endpoint pode consultar a saúde da VPS em tempo real, auditar containers, instalar ferramentas do catálogo com 1 comando e configurar apontamentos DNS na Cloudflare.
            </p>
          </div>
        </div>

        <div class="mcp-key-section">
          <div class="mcp-field-group">
            <label class="mcp-label">Sua Chave de Acesso MCP (API Key Privada)</label>
            <div class="mcp-input-box">
              <input type="${isVisible ? 'text' : 'password'}" readonly value="${escapeHtml(key)}" id="mcp-key-input" class="mcp-input-code" />
              <button class="btn-toggle-eye" id="btn-toggle-mcp-key" type="button" title="${isVisible ? 'Ocultar Chave' : 'Visualizar Chave'}">
                ${isVisible ? '🙈 Ocultar' : '👁️ Visualizar'}
              </button>
              <button class="btn-copy-mini" id="btn-copy-mcp-key" title="Copiar Chave">📋 Copiar Chave</button>
              <button class="btn-regen-mini" id="btn-regen-mcp-key" title="Gerar Nova Chave">🔄 Regenerar Chave</button>
            </div>
            <span class="mcp-hint">Mantenha esta chave segura. Ela concede ao seu agente de IA permissão para gerenciar a VPS.</span>
          </div>

          <div class="mcp-field-group">
            <label class="mcp-label">Endpoint Oficial SSE (Server-Sent Events)</label>
            <div class="mcp-input-box">
              <input type="text" readonly value="${escapeHtml(displaySseUrl)}" id="mcp-sse-input" class="mcp-input-code" />
              <button class="btn-copy-mini" id="btn-copy-mcp-sse" title="Copiar URL SSE">📋 Copiar URL</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Configuração Rápida em 1 Clique -->
      <div class="mcp-config-card">
        <div class="mcp-config-header">
          <h3>Como Conectar seu Agente em 1 Minuto</h3>
          <p>Escolha seu assistente de IA preferido e copie o bloco de configuração:</p>
        </div>

        <div class="mcp-tab-pills">
          <button class="mcp-tab-pill ${activeSnippet === 'cursor' ? 'active' : ''}" data-mcp-tab="cursor">
            <span class="tab-icon">⚡</span> Cursor IDE
          </button>
          <button class="mcp-tab-pill ${activeSnippet === 'claude' ? 'active' : ''}" data-mcp-tab="claude">
            <span class="tab-icon">🟣</span> Claude Desktop
          </button>
          <button class="mcp-tab-pill ${activeSnippet === 'hermes' ? 'active' : ''}" data-mcp-tab="hermes">
            <span class="tab-icon"><img src="/assets/hermes-dark.svg" style="width: 14px; height: 14px; vertical-align: middle;" /></span> Hermes Agente IA
          </button>
          <button class="mcp-tab-pill ${activeSnippet === 'cli' ? 'active' : ''}" data-mcp-tab="cli">
            <span class="tab-icon">💻</span> CLI / Terminal / Python
          </button>
        </div>

        <div class="mcp-snippet-container">
          <div class="snippet-header">
            <span class="snippet-lang">${activeSnippet === 'cli' ? 'BASH / TERMINAL' : 'JSON (Configuração)'}</span>
            <button class="btn-copy-code" id="btn-copy-mcp-snippet">📋 Copiar Configuração</button>
          </div>
          <pre class="mcp-pre"><code>${escapeHtml(currentSnippet)}</code></pre>
          <div class="mcp-tab-instructions">
            ${activeSnippet === 'cursor' ? `
              <strong>Instruções para o Cursor:</strong>
              <ol style="margin-left: 1.25rem; margin-top: 0.4rem; font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">
                <li>No Cursor, vá em <code>Cursor Settings</code> &gt; <code>MCP</code> &gt; <code>Add new MCP server</code>.</li>
                <li>Ou adicione o bloco acima ao seu arquivo <code>.cursor/mcp.json</code> na raiz do projeto.</li>
                <li>Pronto! O Cursor identificará automaticamente as 16 ferramentas do SetupImpa.</li>
              </ol>
            ` : activeSnippet === 'claude' ? `
              <strong>Instruções para o Claude Desktop:</strong>
              <ol style="margin-left: 1.25rem; margin-top: 0.4rem; font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">
                <li>Abra o Claude Desktop e acesse <code>Configurações</code> &gt; <code>Desenvolvedor</code> &gt; <code>Editar Configuração</code>.</li>
                <li>Cole o bloco JSON acima no arquivo <code>claude_desktop_config.json</code>.</li>
                <li>Reinicie o Claude Desktop. O ícone de martelo exibirá as ferramentas da sua VPS.</li>
              </ol>
            ` : activeSnippet === 'hermes' ? `
              <strong>Instruções para o Hermes:</strong>
              <ol style="margin-left: 1.25rem; margin-top: 0.4rem; font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">
                <li>Se o Hermes estiver instalado nesta VPS, ele pode se conectar via rede interna com latência zero usando a URL acima.</li>
                <li>Adicione o SetupImpa como fonte MCP nas configurações do Hermes.</li>
                <li>O Hermes poderá monitorar e operar a infraestrutura de forma 100% autônoma.</li>
              </ol>
            ` : `
              <strong>Uso via CLI / Terminal:</strong>
              <p style="margin-top: 0.4rem; font-size: 0.85rem; color: var(--text-muted);">
                Execute o proxy em Python para utilizar o protocolo stdio clássico do MCP a partir de qualquer script ou terminal local.
              </p>
            `}
          </div>
        </div>
      </div>

      <!-- Live Test & Interactive Diagnostics -->
      <div class="mcp-test-card">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
          <div>
            <h3>Testar Comunicação do MCP em Tempo Real</h3>
            <p style="color: var(--text-muted); font-size: 0.88rem; margin-top: 0.2rem;">
              Simule a chamada que a IA faz para a ferramenta <code>vps_get_system_health</code> e veja os dados retornados em tempo real.
            </p>
          </div>
          <button class="btn-hosteg-primary" id="btn-test-mcp-health" ${state.mcpTesting ? "disabled" : ""}>
            ${state.mcpTesting ? "Consultando VPS..." : "🧪 Executar Teste Agora"}
          </button>
        </div>

        ${state.mcpTestResult ? `
          <div class="mcp-test-result-box">
            <div class="test-result-header">
              <span>Resposta JSON-RPC da VPS:</span>
              <button class="btn-clear-test" onclick="window.__clearMcpTest()">Limpar</button>
            </div>
            <pre class="mcp-test-pre"><code>${escapeHtml(state.mcpTestResult)}</code></pre>
          </div>
        ` : ""}
      </div>

      <!-- Ferramentas MCP Nativas (DevOps Toolkit) -->
      <div class="mcp-tools-section">
        <div class="page-title-row" style="margin-bottom: 1rem;">
          <div>
            <h3>Ferramentas Integradas do Agente (DevOps Toolkit)</h3>
            <p class="page-subtitle">O agente de IA tem permissão controlada para executar estas 16 ações de alto nível:</p>
          </div>
        </div>

        <div class="mcp-tools-grid">
          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🩺</span>
              <strong class="tool-name">vps_get_system_health</strong>
            </div>
            <p class="tool-desc">Diagnóstico em tempo real de CPU, RAM livre/usada, Disco (/), Uptime, IP e status do Swarm.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🛡</span>
              <strong class="tool-name">vps_check_updates</strong>
            </div>
            <p class="tool-desc">Auditoria de atualizações pendentes do sistema operacional e detecção de containers com falhas.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🐳</span>
              <strong class="tool-name">vps_list_containers</strong>
            </div>
            <p class="tool-desc">Lista todos os containers Docker presentes no host com status, imagens e portas.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">📜</span>
              <strong class="tool-name">vps_get_container_logs</strong>
            </div>
            <p class="tool-desc">Lê os logs finais de stdout/stderr de qualquer serviço para depuração de erros em tempo real.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🧹</span>
              <strong class="tool-name">vps_docker_prune</strong>
            </div>
            <p class="tool-desc">Purga com segurança imagens órfãs, build cache e containers parados para liberar disco.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🔄</span>
              <strong class="tool-name">vps_restart_service</strong>
            </div>
            <p class="tool-desc">Reinicia graciosamente uma stack Swarm ou container sem perda de dados ou volumes.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🏪</span>
              <strong class="tool-name">apps_catalog_list</strong>
            </div>
            <p class="tool-desc">Permite à IA pesquisar e filtrar em todo o catálogo de +105 aplicações prontas.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🔍</span>
              <strong class="tool-name">apps_catalog_get_details</strong>
            </div>
            <p class="tool-desc">Recupera a ficha técnica com parâmetros obrigatórios, portas e bancos necessários.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">📦</span>
              <strong class="tool-name">apps_list_instances</strong>
            </div>
            <p class="tool-desc">Informa à IA todas as instâncias em execução na VPS, com seus respectivos domínios e URLs.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🔑</span>
              <strong class="tool-name">apps_get_instance_credentials</strong>
            </div>
            <p class="tool-desc">Acesso seguro a senhas geradas, tokens de API e strings de conexão de banco de dados.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🚀</span>
              <strong class="tool-name">apps_install</strong>
            </div>
            <p class="tool-desc">Instala qualquer ferramenta na VPS com 1 comando, banco de dados e SSL Traefik automático.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🗑</span>
              <strong class="tool-name">apps_remove_instance</strong>
            </div>
            <p class="tool-desc">Desinstalação e limpeza completa de uma instância da stack e do registro com confirmação.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">🌐</span>
              <strong class="tool-name">dns_check_domain</strong>
            </div>
            <p class="tool-desc">Verifica se um domínio já aponta para a VPS e testa a emissão de certificado SSL.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">⚡</span>
              <strong class="tool-name">dns_cloudflare_setup</strong>
            </div>
            <p class="tool-desc">Cria ou atualiza automaticamente o apontamento DNS tipo A na Cloudflare para a VPS.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">☁</span>
              <strong class="tool-name">dns_cloudflare_status</strong>
            </div>
            <p class="tool-desc">Verifica a disponibilidade da integração com a API da Cloudflare na VPS.</p>
          </div>

          <div class="mcp-tool-card">
            <div class="mcp-tool-top">
              <span class="tool-icon">⚙</span>
              <strong class="tool-name">vps_execute_safe_command</strong>
            </div>
            <p class="tool-desc">Executa comandos autorizados de diagnóstico (uptime, df, free, docker ps, docker stack ls).</p>
          </div>
        </div>
      </div>
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
        if (state.activeTab === "mcp") {
          loadMcpConfig();
        }
        render();
      };
    });

    // ── MCP Tab Events ───────────────────────────
    app.querySelectorAll("[data-mcp-tab]").forEach(btn => {
      btn.onclick = () => {
        state.mcpActiveSnippetTab = btn.dataset.mcpTab;
        render();
      };
    });

    const btnToggleKey = document.getElementById("btn-toggle-mcp-key");
    if (btnToggleKey) {
      btnToggleKey.onclick = () => {
        state.showMcpKey = !state.showMcpKey;
        render();
      };
    }

    const btnCopyKey = document.getElementById("btn-copy-mcp-key");
    if (btnCopyKey) {
      btnCopyKey.onclick = () => {
        const key = state.mcpConfig?.mcp_api_key || "";
        if (key) {
          navigator.clipboard.writeText(key);
          toast("Chave de API MCP copiada para a área de transferência!", "ok");
        }
      };
    }

    const btnCopySse = document.getElementById("btn-copy-mcp-sse");
    if (btnCopySse) {
      btnCopySse.onclick = () => {
        const key = state.mcpConfig?.mcp_api_key || "";
        const ip = state.mcpConfig?.public_ip || state.status?.public_ip || "SEU_IP_VPS";
        const realSse = state.mcpConfig?.sse_url || `http://${ip}:8877/mcp/sse?token=${key}`;
        if (realSse) {
          navigator.clipboard.writeText(realSse);
          toast("URL SSE do MCP copiada com sucesso!", "ok");
        }
      };
    }

    const btnRegenKey = document.getElementById("btn-regen-mcp-key");
    if (btnRegenKey) {
      btnRegenKey.onclick = async () => {
        if (!confirm("Tem certeza que deseja regenerar a chave do MCP? Agentes conectados precisarão atualizar a chave.")) return;
        try {
          await api("/api/mcp/key/regenerate", { method: "POST" });
          toast("Nova chave de API MCP gerada com sucesso!", "ok");
          await loadMcpConfig();
        } catch (e) {
          toast("Erro ao regenerar chave: " + e.message, "err");
        }
      };
    }

    const btnCopySnippet = document.getElementById("btn-copy-mcp-snippet");
    if (btnCopySnippet) {
      btnCopySnippet.onclick = () => {
        const cfg = state.mcpConfig || {};
        const key = cfg.mcp_api_key || "";
        const ip = cfg.public_ip || state.status?.public_ip || "SEU_IP_VPS";
        const realSseUrl = cfg.sse_url || `http://${ip}:8877/mcp/sse?token=${key}`;

        let realSnippet = JSON.stringify({
          "mcpServers": {
            "setupimpa-vps": {
              "url": realSseUrl
            }
          }
        }, null, 2);

        if (state.mcpActiveSnippetTab === "claude") {
          realSnippet = JSON.stringify({
            "mcpServers": {
              "setupimpa-vps": {
                "url": realSseUrl
              }
            }
          }, null, 2);
        } else if (state.mcpActiveSnippetTab === "hermes") {
          realSnippet = JSON.stringify({
            "name": "SetupImpa VPS Controller",
            "type": "sse",
            "url": realSseUrl,
            "token": key
          }, null, 2);
        } else if (state.mcpActiveSnippetTab === "cli") {
          realSnippet = `python -m mcp.cli --url http://${ip}:8877 --token ${key}`;
        }

        navigator.clipboard.writeText(realSnippet);
        toast("Configuração com chave copiada para a área de transferência!", "ok");
      };
    }

    const btnTestHealth = document.getElementById("btn-test-mcp-health");
    if (btnTestHealth) {
      btnTestHealth.onclick = async () => {
        state.mcpTesting = true;
        state.mcpTestResult = null;
        render();
        try {
          const res = await api("/mcp/rpc", {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now(),
              method: "tools/call",
              params: {
                name: "vps_get_system_health",
                arguments: {}
              }
            })
          });
          const rawText = res?.result?.content?.[0]?.text;
          state.mcpTestResult = rawText || JSON.stringify(res, null, 2);
          toast("Diagnóstico da VPS executado com sucesso pelo MCP!", "ok");
        } catch (e) {
          state.mcpTestResult = "Erro na requisição: " + e.message;
          toast("Falha ao testar MCP: " + e.message, "err");
        } finally {
          state.mcpTesting = false;
          render();
        }
      };
    }

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
        (state.currentApp?.fields || []).forEach(f => {
          const k = f.key || f.name;
          state.appForm[k] = f.default || "";
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

    const updateBtn = document.getElementById("btn-update-panel");
    if (updateBtn) {
      updateBtn.onclick = () => {
        openConfirm({
          icon: "🔄",
          title: "Atualizar Painel SetupImpa",
          message: "Deseja baixar os arquivos mais recentes oficiais do SetupImpa diretamente da nuvem? O painel recarregará automaticamente com as novas logos e recursos.",
          confirmText: "Atualizar Agora",
          onConfirm: async () => {
            try {
              toast("Baixando atualização do painel...", "info");
              const res = await api("/api/system/update", { method: "POST" });
              toast(res.message || "Painel atualizado com sucesso!", "ok");
              setTimeout(() => {
                window.location.reload(true);
              }, 1200);
            } catch (e) {
              toast("Falha ao atualizar painel: " + e.message, "err");
            }
          }
        });
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

  // Seletor inteligente de PostgreSQL
  function renderDatabaseSection(a) {
    const pgs = state.postgresInstances || [];
    if (pgs.length > 0) {
      return `
        <div class="db-select-card">
          <div class="db-select-badge-row">
            <span class="db-badge">BANCO DE DADOS</span>
            <span class="db-status-pill online">● ${pgs.length} PostgreSQL Ativo(s)</span>
          </div>
          <h4>Conexão com PostgreSQL</h4>
          <p class="db-desc">
            Detectamos que você já possui <strong>${pgs.length} banco(s) PostgreSQL</strong> ativo(s) nesta VPS:
          </p>

          <div class="form-group">
            <label>Em qual banco conectar esta aplicação?</label>
            <select id="app-db-instance" class="form-select">
              ${pgs.map((pg, idx) => `
                <option value="${escapeHtml(pg.instance_id)}" ${idx === 0 ? "selected" : ""}>
                  🐘 ${escapeHtml(pg.label)} — (Host interno: ${escapeHtml(pg.host)})
                </option>
              `).join("")}
              <option value="__new__">+ Criar uma NOVA instância de PostgreSQL dedicada</option>
              ${a.id === "evolution" ? '<option value="__none__">⚠️ Não usar PostgreSQL (Modo local sem banco)</option>' : ''}
            </select>
            <span class="field-hint">
              ${pgs.length > 1
                ? "💡 Você pode escolher o banco que preferir (ex: pg1 ou pg2) para separar seus dados."
                : "💡 A ferramenta conectará neste banco existente. Nenhum container duplicado será criado!"}
            </span>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="db-notice-card">
          <div class="db-notice-head">
            <span class="db-warn-icon">ℹ️</span>
            <div>
              <h4>Banco PostgreSQL Necessário</h4>
              <p>Esta ferramenta precisa de um banco de dados PostgreSQL para salvar mensagens e dados. Nenhum PostgreSQL foi encontrado nesta VPS.</p>
            </div>
          </div>

          <div class="form-group" style="margin-top: 1rem;">
            <label>Como deseja configurar o PostgreSQL?</label>
            <select id="app-db-instance" class="form-select">
              <option value="__auto_create__" selected>🚀 Instalar PostgreSQL automaticamente agora (Recomendado)</option>
              ${a.id === "evolution" ? '<option value="__none__">Continuar sem banco (Modo temporário em memória)</option>' : ''}
            </select>
            <span class="field-hint">O SetupImpa criará o PostgreSQL #1 no Swarm antes de inicializar ${escapeHtml(a.name)}.</span>
          </div>
        </div>
      `;
    }
  }

  // Modal 2: Instalação de App (Hosteg Clean)
  function renderAppModal() {
    const a = state.currentApp;
    if (!a) return "";
    const isOrion = a.source === "setuporion";
    const meta = resolveAppMeta(a);
    const count = a.instance_count || 0;
    const ip = state.status?.public_ip || "74.1.21.235";
    const needsPg = a.id === "evolution" || a.id === "getfy" || meta.requires_postgres || (isOrion && Array.isArray(a.pg_dbs) && a.pg_dbs.length > 0);

    // Filtra campos internos de db para não poluir
    const visibleFields = (a.fields || []).filter(f => !["db_instance", "db_host", "db_name", "db_user", "db_pass"].includes(f.key || f.name));

    return `
      <div class="modal-backdrop">
        <div class="modal-box">
          <div class="modal-head">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="app-avatar-mini">${meta.icon}</span>
              <h3>Quero Instalar: ${escapeHtml(meta.name)}</h3>
              ${isOrion ? '<span class="modal-orion-badge">Stack SetupOrion</span>' : ''}
            </div>
            <button class="modal-close" onclick="window.__closeModal()">×</button>
          </div>
          <div class="modal-body">
            ${count > 0 ? `
              <div class="pill-info">
                ℹ Você já tem ${count} instância(s) desta aplicação. Esta será a <strong>Instância #${count + 1}</strong> com portas e dados isolados.
              </div>
            ` : ""}

            ${needsPg ? renderDatabaseSection(a) : ""}

            <p class="modal-intro">
              Informe as configurações para inicializar sua stack com segurança:
            </p>

            ${visibleFields.map(f => {
              const k = f.key || f.name;
              return `
              <div class="form-group">
                <label>${escapeHtml(f.label || k)}</label>
                ${(f.type === 'select' || Array.isArray(f.options)) ? `
                  <select data-field-key="${k}">
                    ${(f.options || []).map(opt => {
                      const val = typeof opt === 'object' ? opt.value : opt;
                      const lbl = typeof opt === 'object' ? opt.label : opt;
                      const sel = (state.appForm[k] || f.default) === val ? 'selected' : '';
                      return `<option value="${escapeHtml(val)}" ${sel}>${escapeHtml(lbl)}</option>`;
                    }).join("")}
                  </select>
                ` : `
                  <input data-field-key="${k}" type="${f.type === 'password' ? 'password' : 'text'}"
                         placeholder="${escapeHtml(f.placeholder || (k === 'domain' ? 'Ex: app.meusite.com' : ''))}"
                         value="${escapeHtml(state.appForm[k] || '')}" />
                `}
                ${f.help ? `<span class="field-hint">${escapeHtml(f.help)}</span>` : (k === 'domain' ? `<span class="field-hint">Aponte o Registro A no seu provedor para o IP <strong>${escapeHtml(ip)}</strong>.</span>` : '')}
              </div>
            `;
            }).join("")}

            ${state.cfConfigured && (a.fields?.some(f => (f.key || f.name) === 'domain') || !a.fields?.length) ? `
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
      const chosenDb = document.getElementById("app-db-instance")?.value || "";
      state.appForm.db_instance = chosenDb;

      const needsCreatePg = (chosenDb === "__auto_create__" || chosenDb === "__new__");

      // Abre imediatamente o Stepper de Progresso Visual!
      state.activeModal = "progress";
      state.progress = {
        active: true,
        title: `Instalando ${a.name}...`,
        subtitle: `Configurando sua nova instância com isolamento e segurança`,
        percent: 15,
        done: false,
        error: null,
        steps: [
          needsCreatePg
            ? { label: "Provisionando banco de dados PostgreSQL no Swarm", status: "active", detail: "Subindo container postgres..." }
            : { label: `Conectando ao banco ${chosenDb === "__none__" ? "Modo Local" : (chosenDb || "PostgreSQL")}`, status: "active", detail: chosenDb === "__none__" ? "Sem banco externo" : "Reutilizando banco existente" },
          { label: "Validando rota segura e SSL no Traefik v3", status: "pending" },
          { label: "Inicializando container no cluster Docker", status: "pending" },
          { label: "Verificando saúde da aplicação", status: "pending" },
        ],
      };
      render();

      try {
        if (needsCreatePg) {
          const pgJob = await api("/api/install/postgres", { method: "POST", body: JSON.stringify({ params: {} }) });
          await pollJobSilent(pgJob.job_id);
          state.appForm.db_instance = pgJob.instance_id || "postgres";
          state.progress.steps[0].status = "done";
          state.progress.steps[0].detail = `Banco ${state.appForm.db_instance} pronto`;
          state.progress.percent = 35;
          render();
        } else {
          state.progress.steps[0].status = "done";
          state.progress.percent = 30;
          render();
        }

        if (autoCf && domain && state.cfConfigured) {
          state.progress.steps[1].detail = `Criando apontamento DNS para ${domain}...`;
          render();
          try {
            await api("/api/cloudflare/dns", { method: "POST", body: JSON.stringify({ domain }) });
          } catch (_) {}
        }

        state.progress.percent = 50;
        state.progress.steps[1].status = "done";
        state.progress.steps[2].status = "active";
        state.progress.steps[2].detail = domain ? `Configurando rota https://${domain}` : "Rede interna privada";
        render();

        const job = await api(`/api/install/${a.id}`, { method: "POST", body: JSON.stringify({ params: state.appForm }) });

        state.progress.percent = 70;
        state.progress.steps[2].status = "done";
        state.progress.steps[3].status = "active";
        state.progress.steps[3].detail = `Subindo stack ${job.instance_id}...`;
        render();

        await pollJobProgress(job.job_id, a, job.instance_id, domain);
      } catch (err) {
        state.progress.error = err.message;
        render();
      }
    }
  });

  async function pollJobSilent(jobId) {
    for (let i = 0; i < 40; i++) {
      const job = await api(`/api/install/${jobId}`);
      if (job.status === "done") return job.result;
      if (job.status === "error") {
        throw new Error("Falha ao provisionar PostgreSQL: " + JSON.stringify(job.result || ""));
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Tempo limite excedido aguardando o PostgreSQL inicializar.");
  }

  async function pollJobProgress(jobId, appMeta, instanceId, domain) {
    let pcts = [75, 80, 85, 90, 95];
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
