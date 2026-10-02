(() => {
  const app = document.getElementById("app");
  const state = {
    token: localStorage.getItem("setupimpa_session") || "",
    username: localStorage.getItem("setupimpa_user") || "",
    auth: null,
    status: null,
    preflight: null,
    apps: [],
    step: "loading",
    msg: null,
    currentApp: null,
    baseForm: { email: "", portainer_domain: "", user: "admin", password: "" },
    appForm: {},
    authForm: { username: "", password: "", password2: "" },
    expandedApp: null,
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

  function setMsg(text, type = "") {
    state.msg = text ? { text, type } : null;
    render();
  }

  function msgBox() {
    if (!state.msg) return "";
    return `<div class="msg ${state.msg.type || ""}">${escapeHtml(state.msg.text)}</div>`;
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

  function stepsBar(active) {
    const steps = [
      ["gate", "Ciente"],
      ["preflight", "Preflight"],
      ["base", "Base"],
      ["dns", "DNS"],
      ["catalog", "Apps"],
    ];
    const order = steps.map((s) => s[0]);
    const idx = order.indexOf(active);
    return `<div class="rail">${steps
      .map(([id, label], i) => {
        const cls = i < idx ? "done" : i === idx ? "on" : "";
        return `<span class="${cls}">${label}</span>`;
      })
      .join("")}</div>`;
  }

  function topbar() {
    const ip = state.status?.public_ip || "—";
    const ver = state.status?.version || state.auth?.version || "";
    return `<div class="topbar">
      <div class="mini-brand">Setup<em>Impa</em></div>
      <div class="top-meta">
        <span>${escapeHtml(state.username || "admin")} · v${escapeHtml(ver)} · ${escapeHtml(ip)}</span>
        <button class="ghost" id="btn-logout" type="button">Sair</button>
      </div>
    </div>`;
  }

  function bindLogout() {
    const btn = document.getElementById("btn-logout");
    if (!btn) return;
    btn.onclick = async () => {
      try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (_) {}
      clearSession();
      state.step = "auth";
      state.msg = null;
      boot();
    };
  }

  // ── Auth ──────────────────────────────────────────────────────
  function renderAuth() {
    const setup = !!state.auth?.setup_required;
    app.innerHTML = `<section class="auth-stage">
      <div class="kicker"><i></i> IMPA 365</div>
      <h1 class="auth-brand">Setup<em>Impa</em></h1>
      <p class="auth-lead">Instale Traefik, Portainer, Postgres, Evolution, Hermes e Getfy pelo navegador — com preflight, DNS gate e validação de verdade. Suporte a multiplas instancias.</p>
      <form class="auth-form" id="auth-form">
        <h2>${setup ? "Crie seu acesso" : "Entrar"}</h2>
        <p class="hint">${setup
          ? "Primeiro acesso: defina usuario e senha do painel. Guarde bem — e o unico login deste instalador."
          : "Use o usuario e a senha criados no primeiro acesso."}</p>
        <div class="field">
          <label>Usuario</label>
          <input id="user" name="username" autocomplete="username" value="${escapeHtml(state.authForm.username)}" required minlength="3" />
        </div>
        <div class="field">
          <label>Senha</label>
          <input id="pass" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required minlength="8" />
        </div>
        ${setup ? `<div class="field"><label>Confirmar senha</label><input id="pass2" type="password" autocomplete="new-password" required minlength="8" /></div>` : ""}
        <div class="auth-actions">
          <button type="submit">${setup ? "Criar acesso e entrar" : "Entrar no painel"}</button>
        </div>
        ${msgBox()}
      </form>
    </section>`;

    document.getElementById("auth-form").onsubmit = async (e) => {
      e.preventDefault();
      const username = document.getElementById("user").value.trim();
      const password = document.getElementById("pass").value;
      if (setup) {
        const password2 = document.getElementById("pass2").value;
        if (password !== password2) return setMsg("As senhas nao coincidem.", "err");
        if (password.length < 8) return setMsg("Senha com no minimo 8 caracteres.", "err");
      }
      try {
        const path = setup ? "/api/auth/setup" : "/api/auth/login";
        const res = await api(path, { method: "POST", body: JSON.stringify({ username, password }) });
        persistSession(res.token, res.username);
        state.msg = null;
        await afterLogin();
      } catch (err) {
        const map = {
          ja_configurado: "Acesso ja foi criado. Faca login.",
          usuario_curto: "Usuario muito curto (min. 3).",
          senha_curta: "Senha muito curta (min. 8).",
          credenciais_invalidas: "Usuario ou senha invalidos.",
          setup_required: "Ainda nao existe acesso. Crie o primeiro usuario.",
        };
        setMsg(map[err.message] || err.message, "err");
      }
    };
  }

  async function afterLogin() {
    state.status = await api("/api/status");
    if (!state.status.accepted_risk) {
      state.step = "gate";
    } else if (!state.status.base_installed) {
      state.step = "preflight";
      state.preflight = await api("/api/preflight", { method: "POST", body: "{}" });
    } else {
      state.step = "catalog";
      await loadApps();
    }
    render();
  }

  // ── Gate ──────────────────────────────────────────────────────
  function renderGate() {
    app.innerHTML = `<div class="shell">
      ${topbar()}
      ${stepsBar("gate")}
      <div class="stage">
        <h2>Antes de continuar</h2>
        <p class="sub">Este instalador sobe Docker Swarm, Traefik, Portainer e apps nesta VPS. Confirme que e o ambiente certo.</p>
        <ul class="list-clean">
          <li>Debian 11–13 ou Ubuntu 20.04+</li>
          <li>VPS limpa de preferencia (ou ciente se Docker ja existe)</li>
          <li>Feche a porta 8877 depois do setup</li>
        </ul>
        <div class="cta-row">
          <button id="btn-accept" type="button">Estou ciente — continuar</button>
        </div>
        ${msgBox()}
      </div>
    </div>`;
    bindLogout();
    document.getElementById("btn-accept").onclick = async () => {
      try {
        await api("/api/accept", { method: "POST", body: JSON.stringify({ accepted: true }) });
        state.step = "preflight";
        state.preflight = await api("/api/preflight", { method: "POST", body: "{}" });
        render();
      } catch (e) {
        setMsg(e.message, "err");
      }
    };
  }

  // ── Preflight ─────────────────────────────────────────────────
  function renderPreflight() {
    const checks = state.preflight?.checks || [];
    app.innerHTML = `<div class="shell">
      ${topbar()}
      ${stepsBar("preflight")}
      <div class="stage">
        <h2>Preflight</h2>
        <p class="sub">Checagens do IMPA Migrator: SO, disco, Docker e Swarm.</p>
        <div>
          ${checks.map((c) => {
            const cls = !c.ok ? "bad" : c.warn ? "warn" : "ok";
            return `<div class="check"><div class="dot ${cls}"></div><div><div class="lbl">${escapeHtml(c.label)}</div><div class="det">${escapeHtml(c.detail || "")}</div></div></div>`;
          }).join("")}
        </div>
        <div class="cta-row">
          <button id="btn-next" type="button" ${state.preflight?.ok ? "" : "disabled"}>Continuar</button>
          <button class="ghost" id="btn-refresh" type="button">Reverificar</button>
        </div>
        ${msgBox()}
      </div>
    </div>`;
    bindLogout();
    document.getElementById("btn-refresh").onclick = async () => {
      try {
        state.preflight = await api("/api/preflight", { method: "POST", body: "{}" });
        render();
      } catch (e) {
        setMsg(e.message, "err");
      }
    };
    document.getElementById("btn-next").onclick = async () => {
      if (state.preflight?.base_installed) {
        state.step = "catalog";
        await loadApps();
      } else {
        state.step = "base";
      }
      render();
    };
  }

  // ── Base ──────────────────────────────────────────────────────
  function renderBase() {
    const f = state.baseForm;
    app.innerHTML = `<div class="shell">
      ${topbar()}
      ${stepsBar("base")}
      <div class="stage">
        <h2>Infra base</h2>
        <p class="sub">Traefik v3.6.1 com providers.swarm + Portainer CE.</p>
        <div class="grid two">
          <div class="field"><label>Email Let's Encrypt</label><input id="email" value="${escapeHtml(f.email)}" placeholder="admin@seudominio.com" /></div>
          <div class="field"><label>Dominio do Portainer</label><input id="domain" value="${escapeHtml(f.portainer_domain)}" placeholder="portainer.seudominio.com" /></div>
          <div class="field"><label>Usuario admin Portainer</label><input id="user" value="${escapeHtml(f.user)}" /></div>
          <div class="field"><label>Senha (vazio = gerar)</label><input id="pass" type="password" value="${escapeHtml(f.password)}" /></div>
        </div>
        <div class="cta-row">
          <button id="btn-install" type="button">Instalar Traefik + Portainer</button>
        </div>
        ${msgBox()}
      </div>
    </div>`;
    bindLogout();
    document.getElementById("btn-install").onclick = async () => {
      state.baseForm = {
        email: document.getElementById("email").value.trim(),
        portainer_domain: document.getElementById("domain").value.trim(),
        user: document.getElementById("user").value.trim() || "admin",
        password: document.getElementById("pass").value,
      };
      try {
        setMsg("Instalando base… aguarde.", "");
        const res = await api("/api/install/base", { method: "POST", body: JSON.stringify(state.baseForm) });
        if (!res.ok) throw new Error(res.error || "falha");
        state.step = "dns";
        state.msg = { text: res.message || "Aponte o DNS e valide.", type: "warn" };
        render();
      } catch (e) {
        setMsg(e.message, "err");
      }
    };
  }

  // ── DNS Gate ──────────────────────────────────────────────────
  function renderDns() {
    const d = state.baseForm.portainer_domain;
    app.innerHTML = `<div class="shell">
      ${topbar()}
      ${stepsBar("dns")}
      <div class="stage">
        <h2>DNS Gate</h2>
        <p class="sub">O A record de <strong>${escapeHtml(d)}</strong> precisa apontar para <strong>${escapeHtml(state.status?.public_ip || "")}</strong>. Cloudflare proxy? confirme manualmente.</p>
        <div class="cta-row">
          <button id="btn-check" type="button">Verificar DNS</button>
          <button class="ghost" id="btn-cf" type="button">Ja configurei no Cloudflare</button>
        </div>
        ${msgBox()}
      </div>
    </div>`;
    bindLogout();
    document.getElementById("btn-check").onclick = async () => {
      try {
        const dns = await api("/api/dns/check", { method: "POST", body: JSON.stringify({ domain: d }) });
        if (dns.match) {
          const fin = await api("/api/install/base/finish", { method: "POST", body: JSON.stringify({ confirm_cloudflare: false }) });
          if (!fin.ok) throw new Error(fin.error || "finish_failed");
          state.step = "catalog";
          state.msg = {
            text: `Portainer pronto.\nURL: ${fin.credentials?.url}\nUsuario: ${fin.credentials?.user}\nSenha: ${fin.credentials?.password}`,
            type: "ok",
          };
          await loadApps();
          render();
        } else if (dns.cloudflare) {
          setMsg(`Cloudflare detectado (${dns.resolved}). Confirme o A record para ${dns.expected}.`, "warn");
        } else {
          setMsg(`Ainda nao aponta para esta VPS.\nResolvido: ${dns.resolved || "—"}\nEsperado: ${dns.expected}`, "warn");
        }
      } catch (e) {
        setMsg(e.message, "err");
      }
    };
    document.getElementById("btn-cf").onclick = async () => {
      try {
        const fin = await api("/api/install/base/finish", { method: "POST", body: JSON.stringify({ confirm_cloudflare: true }) });
        if (!fin.ok) throw new Error(fin.error || JSON.stringify(fin));
        state.step = "catalog";
        state.msg = {
          text: `Portainer pronto.\nURL: ${fin.credentials?.url}\nUsuario: ${fin.credentials?.user}\nSenha: ${fin.credentials?.password}`,
          type: "ok",
        };
        await loadApps();
        render();
      } catch (e) {
        setMsg(e.message, "err");
      }
    };
  }

  // ── Catalog — multi-instance ──────────────────────────────────
  async function loadApps() {
    const data = await api("/api/apps");
    state.apps = data.apps || [];
  }

  function instanceBadge(count) {
    if (count === 0) return '<span class="badge">Pronto</span>';
    return `<span class="badge ok">${count} instância${count > 1 ? "s" : ""}</span>`;
  }

  function renderInstances(a) {
    if (!a.instances || a.instances.length === 0) return "";
    return `<div class="inst-list">
      <div class="inst-header">Instancias ativas</div>
      ${a.instances.map((inst) => `
        <div class="inst-row">
          <div class="inst-info">
            <strong>${escapeHtml(inst.instance_id)}</strong>
            <span class="inst-domain">${escapeHtml(inst.domain || inst.credentials?.host || "—")}</span>
            <span class="inst-date">${escapeHtml((inst.created_at || "").slice(0, 10))}</span>
          </div>
          <div class="inst-actions">
            <button class="mini ghost" data-inst-creds="${escapeHtml(inst.instance_id)}">Credenciais</button>
            <button class="mini danger" data-inst-rm="${escapeHtml(inst.instance_id)}">Remover</button>
          </div>
        </div>
      `).join("")}
    </div>`;
  }

  function renderCatalog() {
    app.innerHTML = `<div class="shell">
      ${topbar()}
      ${stepsBar("catalog")}
      <div class="stage">
        <h2>Catalogo</h2>
        <p class="sub">Escolha o que instalar. Clique em "Nova instancia" para adicionar mais de uma do mesmo app.</p>
        <div class="cards">
          ${state.apps.map((a) => {
            const isBase = a.id === "base";
            const multi = a.multi_instance !== false && !isBase;
            const count = a.instance_count || 0;
            const badge = isBase
              ? (a.installed ? '<span class="badge ok">Instalado</span>' : '<span class="badge">Pendente</span>')
              : (a.blocked ? '<span class="badge blocked">Bloqueado</span>' : instanceBadge(count));
            const expanded = state.expandedApp === a.id;

            let action = "";
            if (isBase) {
              action = a.installed ? "" : `<button type="button" data-base="1">Instalar base</button>`;
            } else {
              const label = count > 0 && multi ? "+ Nova instancia" : "Instalar";
              action = `<button type="button" data-app="${a.id}" ${a.blocked ? "disabled" : ""}>${label}</button>`;
              if (count > 0) {
                action += ` <button class="ghost" type="button" data-expand="${a.id}">${expanded ? "▲ Ocultar" : "▼ Detalhes"} (${count})</button>`;
              }
            }

            return `<article class="card">
              ${badge}
              <h3>${escapeHtml(a.name)}</h3>
              <p>${escapeHtml(a.description || "")}</p>
              ${multi && !isBase ? '<div class="multi-tag">Multi-instância</div>' : ""}
              <div class="card-actions">${action}</div>
              ${expanded ? renderInstances(a) : ""}
            </article>`;
          }).join("")}
        </div>
        ${msgBox()}
      </div>
    </div>`;
    bindLogout();

    // Bind new instance / install
    app.querySelectorAll("[data-app]").forEach((btn) => {
      btn.onclick = () => {
        state.currentApp = state.apps.find((x) => x.id === btn.dataset.app);
        state.appForm = {};
        (state.currentApp.fields || []).forEach((f) => (state.appForm[f.key] = f.default || ""));
        state.step = "app";
        render();
      };
    });

    // Bind base
    app.querySelectorAll("[data-base]").forEach((btn) => {
      btn.onclick = () => {
        state.step = "base";
        render();
      };
    });

    // Bind expand/collapse instances
    app.querySelectorAll("[data-expand]").forEach((btn) => {
      btn.onclick = () => {
        const appId = btn.dataset.expand;
        state.expandedApp = state.expandedApp === appId ? null : appId;
        render();
      };
    });

    // Bind instance credentials
    app.querySelectorAll("[data-inst-creds]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const c = await api(`/api/credentials/${btn.dataset.instCreds}`);
          setMsg(c.content, "ok");
        } catch (e) {
          setMsg(e.message, "err");
        }
      };
    });

    // Bind instance remove
    app.querySelectorAll("[data-inst-rm]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.instRm;
        if (!confirm(`Remover instância ${id}? A stack será removida do Docker Swarm.`)) return;
        try {
          setMsg(`Removendo ${id}...`, "");
          await api(`/api/instance/${id}`, { method: "DELETE" });
          state.expandedApp = null;
          await loadApps();
          setMsg(`Instância ${id} removida.`, "ok");
        } catch (e) {
          setMsg(e.message, "err");
        }
      };
    });
  }

  // ── App form (new instance) ───────────────────────────────────
  function renderAppForm() {
    const a = state.currentApp;
    if (!a) {
      state.step = "catalog";
      return render();
    }
    const count = a.instance_count || 0;
    const isNew = count > 0;
    app.innerHTML = `<div class="shell">
      ${topbar()}
      ${stepsBar("catalog")}
      <div class="stage">
        <h2>${escapeHtml(a.name)} ${isNew ? `<span class="new-inst-tag">nova instância #${count + 1}</span>` : ""}</h2>
        <p class="sub">${escapeHtml(a.description || "")}</p>
        ${isNew ? '<p class="hint">Cada instância recebe sua própria stack, volumes e rota Traefik. Use um domínio diferente.</p>' : ""}
        <div class="grid two">
          ${(a.fields || []).map((f) =>
            `<div class="field"><label>${escapeHtml(f.label)}</label><input data-k="${f.key}" value="${escapeHtml(state.appForm[f.key] || "")}" /></div>`
          ).join("")}
        </div>
        <div class="cta-row">
          <button id="btn-go" type="button">${isNew ? "Adicionar instância" : "Instalar"}</button>
          <button class="ghost" id="btn-back" type="button">Voltar</button>
        </div>
        ${msgBox()}
      </div>
    </div>`;
    bindLogout();
    document.getElementById("btn-back").onclick = () => {
      state.step = "catalog";
      render();
    };
    document.getElementById("btn-go").onclick = async () => {
      app.querySelectorAll("[data-k]").forEach((inp) => {
        state.appForm[inp.dataset.k] = inp.value.trim();
      });
      try {
        setMsg("Instalando…", "");
        const job = await api(`/api/install/${a.id}`, { method: "POST", body: JSON.stringify({ params: state.appForm }) });
        await pollJob(job.job_id, a, job.instance_id);
      } catch (e) {
        setMsg(e.message, "err");
      }
    };
  }

  async function pollJob(jobId, appMeta, instanceId) {
    for (let i = 0; i < 60; i++) {
      const job = await api(`/api/install/${jobId}`);
      if (job.status === "done" || job.status === "error") {
        const r = job.result || {};
        if (!r.ok) {
          setMsg(r.error || JSON.stringify(r), "err");
          return;
        }
        let text = `${appMeta.name} instalado — instância: ${instanceId || r.instance_id || ""}`;
        if (r.credentials) text += "\n" + JSON.stringify(r.credentials, null, 2);
        if (r.message) text += `\n${r.message}`;
        state.msg = { text, type: r.dns_required ? "warn" : "ok" };
        state.step = "catalog";
        state.expandedApp = appMeta.id;
        await loadApps();
        render();
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setMsg("Timeout aguardando job", "err");
  }

  // ── Router ────────────────────────────────────────────────────
  function render() {
    if (state.step === "loading") {
      app.innerHTML = `<section class="auth-stage"><div class="kicker"><i></i> carregando</div><h1 class="auth-brand">Setup<em>Impa</em></h1></section>`;
      return;
    }
    if (state.step === "auth") return renderAuth();
    if (state.step === "gate") return renderGate();
    if (state.step === "preflight") return renderPreflight();
    if (state.step === "base") return renderBase();
    if (state.step === "dns") return renderDns();
    if (state.step === "catalog") return renderCatalog();
    if (state.step === "app") return renderAppForm();
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
      setMsg(e.message, "err");
    }
  }

  boot();
})();
