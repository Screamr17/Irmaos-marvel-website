
(() => {
  "use strict";

  const API = "/api/aq-assignments";
  const MEMBERS_API = "/api/members";

  const LIMITS = {
    1: 7,
    2: 9,
    3: 8
  };

  let group = 1;
  let tier = 1;
  let members = [];
  let assignments = [];
  let busy = false;
  let loaded = false;

  const $ = id => document.getElementById(id);

  // Criar o painel AQ
  const section = document.createElement("section");

  section.className = "roster-admin";
  section.id = "gestao-aq";

  section.innerHTML = `
    <span class="admin-pill">
      🛡️ AQ MAPA 8 • CLOUDFLARE D1
    </span>

    <h2>🛡️ Gestão dos Caminhos AQ M8</h2>

    <p>
      Organiza os caminhos de cada jogador nos três
      grupos da aliança. Cada Tier tem atribuições
      independentes.
    </p>

    <div class="roster-toolbar" id="aq-group-tabs">
      <button type="button" data-aq-group="1"
        class="selected">G1</button>
      <button type="button" data-aq-group="2">G2</button>
      <button type="button" data-aq-group="3">G3</button>
    </div>

    <div class="roster-toolbar" id="aq-tier-tabs">
      <button type="button" data-aq-tier="1"
        class="selected">Tier 1 · 7 linhas</button>
      <button type="button" data-aq-tier="2">
        Tier 2 · 9 linhas
      </button>
      <button type="button" data-aq-tier="3">
        Tier 3 · 8 linhas
      </button>
    </div>

    <div id="aq-admin-status"
      class="roster-status" role="status">
      A carregar caminhos e jogadores…
    </div>

    <div id="aq-admin-lines" class="v13-list"></div>

    <div class="quick-links">
      <button type="button" id="aq-admin-refresh"
        class="admin-link">
        ↻ Atualizar caminhos
      </button>

      <a class="admin-link" href="aq.html">
        🌐 Ver página pública AQ
      </a>
    </div>
  `;

  // Inserir antes do painel de publicações
  const reference = $("gestao-v13");

  if (reference) {
    reference.before(section);
  } else {
    document.querySelector("main")?.append(section);
  }

  // Adicionar atalho no topo
  const quickLinks = document.querySelector(".quick-links");

  if (quickLinks) {
    const link = document.createElement("a");
    link.href = "#gestao-aq";
    link.textContent = "🛡️ Caminhos AQ";
    quickLinks.append(link);
  }

  function status(message) {
    $("aq-admin-status").textContent = message;
  }

  async function getData(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    const data = await response.json().catch(() => ({
      error: "Resposta inválida do servidor."
    }));

    if (!response.ok) {
      throw new Error(
        data.error || "Erro HTTP " + response.status
      );
    }

    return data;
  }

  async function saveLine(line, memberId) {
    const response = await fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        group_no: group,
        tier: tier,
        line_no: line,
        member_id: memberId
      })
    });

    const data = await response.json().catch(() => ({
      error: "Resposta inválida do servidor."
    }));

    if (!response.ok || !data.ok) {
      throw new Error(
        data.error || "Não foi possível guardar."
      );
    }

    return data;
  }

  function render() {
    const groupTabs = $("aq-group-tabs");
    const tierTabs = $("aq-tier-tabs");
    const container = $("aq-admin-lines");

    for (const button of groupTabs.querySelectorAll("button")) {
      button.classList.toggle(
        "selected",
        Number(button.dataset.aqGroup) === group
      );
    }

    for (const button of tierTabs.querySelectorAll("button")) {
      button.classList.toggle(
        "selected",
        Number(button.dataset.aqTier) === tier
      );
    }

    container.replaceChildren();

    if (!loaded) return;

    const roster = members
      .filter(player => Number(player.group_no) === group)
      .sort((a, b) =>
        Number(a.position || 0) -
        Number(b.position || 0)
      );

    if (!roster.length) {
      status(
        "⚠️ Não existem jogadores disponíveis no G" +
        group + ". Verifica a lista de membros."
      );
      return;
    }

    for (let line = 1; line <= LIMITS[tier]; line++) {
      const existing = assignments.find(item =>
        Number(item.group_no) === group &&
        Number(item.tier) === tier &&
        Number(item.line_no) === line
      );

      const card = document.createElement("article");
      card.className = "v13-entry";

      const heading = document.createElement("h3");
      heading.textContent = "🛡️ Linha " + line;

      const select = document.createElement("select");

      select.setAttribute(
        "aria-label",
        "Jogador da linha " + line
      );

      select.style.cssText = `
        width:100%;
        padding:13px;
        border:1px solid #477fb6;
        border-radius:11px;
        background:#05172f;
        color:#fff;
      `;

      const free = document.createElement("option");
      free.value = "";
      free.textContent = "🟢 Livre";
      select.append(free);

      for (const player of roster) {
        const assignedElsewhere = assignments.some(item =>
          Number(item.group_no) === group &&
          Number(item.tier) === tier &&
          Number(item.member_id) === Number(player.id) &&
          Number(item.line_no) !== line
        );

        const option = document.createElement("option");

        option.value = String(player.id);
        option.textContent = player.name +
          (assignedElsewhere ? " · Já atribuído" : "");

        option.disabled = assignedElsewhere;

        select.append(option);
      }

      select.value = existing
        ? String(existing.member_id)
        : "";

      if (select.selectedIndex < 0 && existing) {
        const unknown = document.createElement("option");
        unknown.value = String(existing.member_id);
        unknown.textContent = "⚠️ Jogador não encontrado";
        select.append(unknown);
        select.value = unknown.value;
      }

      const save = document.createElement("button");

      save.type = "button";
      save.textContent = "💾 Guardar linha " + line;

      save.style.cssText = `
        margin-top:12px;
        background:#125fae;
        color:white;
        border:1px solid #5caaf0;
        border-radius:11px;
        padding:12px 15px;
        font-weight:850;
      `;

      save.onclick = async () => {
        if (busy) return;

        busy = true;
        save.disabled = true;

        const selectedGroup = group;
        const selectedTier = tier;

        const memberId = select.value === ""
          ? null
          : Number(select.value);

        status(
          "⏳ A guardar G" + selectedGroup +
          " · Tier " + selectedTier +
          " · Linha " + line + "…"
        );

        try {
          await saveLine(line, memberId);
          await load();

          status(
            "✓ Caminho guardado! G" + selectedGroup +
            " · Tier " + selectedTier +
            " · Linha " + line
          );
        } catch (error) {
          status("⚠️ " + error.message);
          save.disabled = false;
        } finally {
          busy = false;
        }
      };

      card.append(heading, select, save);
      container.append(card);
    }
  }

  async function load() {
    status("⏳ A carregar dados da Cloudflare D1…");

    try {
      const [aqData, memberData] = await Promise.all([
        getData(API),
        getData(MEMBERS_API)
      ]);

      if (
        !Array.isArray(aqData.items) ||
        !Array.isArray(memberData.items)
      ) {
        throw new Error("Dados inválidos das APIs.");
      }

      assignments = aqData.items;
      members = memberData.items;
      loaded = true;

      render();

      const count = assignments.filter(item =>
        Number(item.group_no) === group &&
        Number(item.tier) === tier
      ).length;

      status(
        "✓ G" + group +
        " · Tier " + tier +
        " · " + count + " linha(s) atribuída(s)."
      );

    } catch (error) {
      status("⚠️ " + error.message);
    }
  }

  $("aq-group-tabs").onclick = event => {
    if (busy) return;

    const button = event.target.closest(
      "button[data-aq-group]"
    );

    if (!button) return;

    group = Number(button.dataset.aqGroup);
    render();
  };

  $("aq-tier-tabs").onclick = event => {
    if (busy) return;

    const button = event.target.closest(
      "button[data-aq-tier]"
    );

    if (!button) return;

    tier = Number(button.dataset.aqTier);
    render();
  };

  $("aq-admin-refresh").onclick = load;

  load();
})();
