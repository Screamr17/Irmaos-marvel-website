
(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const limits = {
    1: 7,
    2: 9,
    3: 8
  };

  let group = 1;
  let tier = 1;
  let members = [];
  let assignments = [];
  let busy = false;

  // Criar painel AQ dos oficiais
  if ($("gestao-aq")) return;

  const section = document.createElement("section");
  section.className = "roster-admin";
  section.id = "gestao-aq";

  section.innerHTML = `
    <span class="admin-pill">
      🛡️ AQ MAPA 8 • CLOUDFLARE D1
    </span>

    <h2>🛡️ Gestão dos Caminhos AQ M8</h2>

    <p>
      Escolhe o grupo e o Tier para atribuir
      os jogadores aos caminhos.
      Cada jogador pode ocupar apenas uma linha
      por Tier.
    </p>

    <div class="roster-toolbar" id="aq-group-tabs">
      <button type="button" data-aq-group="1">G1</button>
      <button type="button" data-aq-group="2">G2</button>
      <button type="button" data-aq-group="3">G3</button>
    </div>

    <div class="roster-toolbar" id="aq-tier-tabs">
      <button type="button" data-aq-tier="1">
        Tier 1 · 7 linhas
      </button>

      <button type="button" data-aq-tier="2">
        Tier 2 · 9 linhas
      </button>

      <button type="button" data-aq-tier="3">
        Tier 3 · 8 linhas
      </button>
    </div>

    <div id="aq-admin-status"
         class="roster-status"
         role="status">
      A carregar jogadores...
    </div>

    <div id="aq-admin-lines" class="v13-list"></div>

    <div class="roster-toolbar">
      <button type="button"
              id="aq-admin-refresh"
              class="admin-link">
        ↻ Atualizar caminhos
      </button>

      <a href="aq.html" class="admin-link">
        🌐 Ver página pública AQ
      </a>
    </div>
  `;

  const before = $("gestao-v13");

  if (before) {
    before.before(section);
  } else {
    document.querySelector("main")?.append(section);
  }

  const quick = document.querySelector(".quick-links");

  if (quick && !quick.querySelector('a[href="#gestao-aq"]')) {
    const link = document.createElement("a");
    link.href = "#gestao-aq";
    link.textContent = "🛡️ Caminhos AQ";
    quick.append(link);
  }

  function status(message) {
    $("aq-admin-status").textContent = message;
  }

  async function get(url) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    const data = await response.json().catch(() => ({
      error: "Resposta inválida da API."
    }));

    if (!response.ok) {
      throw new Error(
        data.error || "Erro HTTP " + response.status
      );
    }

    return data;
  }

  async function save(line, memberId) {
    const response = await fetch("/api/aq-assignments", {
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
      error: "Resposta inválida da API."
    }));

    if (!response.ok || !data.ok) {
      throw new Error(
        data.error || "Não foi possível guardar."
      );
    }

    return data;
  }

  function render() {
    $("aq-group-tabs")
      .querySelectorAll("button")
      .forEach(button => {
        button.classList.toggle(
          "selected",
          Number(button.dataset.aqGroup) === group
        );
      });

    $("aq-tier-tabs")
      .querySelectorAll("button")
      .forEach(button => {
        button.classList.toggle(
          "selected",
          Number(button.dataset.aqTier) === tier
        );
      });

    const target = $("aq-admin-lines");
    target.replaceChildren();

    const roster = members
      .filter(member => Number(member.group_no) === group)
      .sort((a, b) =>
        Number(a.position) - Number(b.position)
      );

    for (let line = 1; line <= limits[tier]; line++) {
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
      free.textContent = "🟢 Por atribuir";
      select.append(free);

      for (const member of roster) {
        const assignedElsewhere = assignments.some(item =>
          Number(item.group_no) === group &&
          Number(item.tier) === tier &&
          Number(item.member_id) === Number(member.id) &&
          Number(item.line_no) !== line
        );

        const option = document.createElement("option");
        option.value = String(member.id);
        option.textContent = String(member.name || "Jogador");

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

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "💾 Guardar linha " + line;

      button.style.cssText = `
        margin-top:12px;
        background:#125fae;
        color:white;
        border:1px solid #5caaf0;
        border-radius:11px;
        padding:12px 15px;
        font-weight:850;
        cursor:pointer;
      `;

      button.onclick = async () => {
        if (busy) return;

        const selectedGroup = group;
        const selectedTier = tier;
        const selectedLine = line;
        const chosen = select.value === ""
          ? null
          : Number(select.value);

        busy = true;
        button.disabled = true;

        status("⏳ A guardar caminho...");

        try {
          await save(selectedLine, chosen);
          await load();

          status(
            "✓ G" + selectedGroup +
            " · Tier " + selectedTier +
            " · Linha " + selectedLine +
            " guardada."
          );
        } catch (error) {
          status("⚠️ " + error.message);
        } finally {
          busy = false;
          button.disabled = false;
        }
      };

      card.append(heading, select, button);
      target.append(card);
    }

    if (!roster.length) {
      status(
        "⚠️ Nenhum jogador encontrado no G" + group +
        ". Verifica /api/public/members."
      );
    }
  }

  async function load() {
    status("⏳ A carregar jogadores e caminhos...");

    try {
      const [aqData, membersData] = await Promise.all([
        get("/api/aq-assignments"),
        get("/api/public/members")
      ]);

      if (
        !Array.isArray(aqData.items) ||
        !Array.isArray(membersData.items)
      ) {
        throw new Error("Formato inválido dos dados.");
      }

      assignments = aqData.items;
      members = membersData.items;

      render();

      const rosterCount = members.filter(
        member => Number(member.group_no) === group
      ).length;

      const assignedCount = assignments.filter(item =>
        Number(item.group_no) === group &&
        Number(item.tier) === tier
      ).length;

      if (rosterCount) {
        status(
          "✓ G" + group +
          " · " + rosterCount + " jogadores disponíveis" +
          " · Tier " + tier +
          " · " + assignedCount + " linhas atribuídas."
        );
      }
    } catch (error) {
      status("⚠️ " + error.message);
    }
  }

  $("aq-group-tabs").onclick = event => {
    const button = event.target.closest("[data-aq-group]");
    if (!button || busy) return;

    group = Number(button.dataset.aqGroup);
    render();
  };

  $("aq-tier-tabs").onclick = event => {
    const button = event.target.closest("[data-aq-tier]");
    if (!button || busy) return;

    tier = Number(button.dataset.aqTier);
    render();
  };

  $("aq-admin-refresh").onclick = () => {
    if (!busy) load();
  };

  load();
})();
