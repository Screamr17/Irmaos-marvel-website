
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

  const section = document.createElement("section");

  section.className = "roster-admin";
  section.id = "gestao-aq";

  section.innerHTML = `
    <span class="admin-pill">
      🛡️ AQ MAPA 8 • CLOUDFLARE D1
    </span>

    <h2>🛡️ Gestão dos Caminhos AQ M8</h2>

    <p>
      Escolhe o grupo e o Tier.
      Cada jogador pode ocupar apenas uma linha
      em cada Tier.
      As alterações ficam visíveis na página pública AQ.
    </p>

    <div class="roster-toolbar" id="aq-group-tabs">
      <button type="button"
        data-aq-group="1" class="selected">G1</button>

      <button type="button"
        data-aq-group="2">G2</button>

      <button type="button"
        data-aq-group="3">G3</button>
    </div>

    <div class="roster-toolbar" id="aq-tier-tabs">
      <button type="button"
        data-aq-tier="1" class="selected">
        Tier 1 · 7 linhas
      </button>

      <button type="button"
        data-aq-tier="2">
        Tier 2 · 9 linhas
      </button>

      <button type="button"
        data-aq-tier="3">
        Tier 3 · 8 linhas
      </button>
    </div>

    <div id="aq-admin-status"
      class="roster-status" role="status">
      A carregar caminhos e jogadores…
    </div>

    <div id="aq-admin-lines" class="v13-list"></div>

    <button type="button"
      id="aq-admin-refresh"
      class="admin-link">
      ↻ Atualizar caminhos
    </button>

    <a class="admin-link" href="aq.html">
      🌐 Ver página pública AQ
    </a>
  `;

  const before = $("gestao-v13");

  if (before) {
    before.before(section);
  } else {
    document.querySelector("main")?.append(section);
  }

  const quick = document.querySelector(".quick-links");

  if (quick) {
    const a = document.createElement("a");
    a.href = "#gestao-aq";
    a.textContent = "🛡️ Caminhos AQ";
    quick.append(a);
  }

  const status = message => {
    $("aq-admin-status").textContent = message;
  };

  async function get(url) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    const data = await response.json().catch(() => ({
      error: "Resposta não JSON"
    }));

    if (!response.ok) {
      throw Error(
        data.error || "HTTP " + response.status
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
      error: "Resposta não JSON"
    }));

    if (!response.ok || !data.ok) {
      throw Error(
        data.error || "Não foi possível guardar."
      );
    }

    return data;
  }

  function render() {
    for (const button of
      $("aq-group-tabs").querySelectorAll("button")) {

      button.classList.toggle(
        "selected",
        Number(button.dataset.aqGroup) === group
      );
    }

    for (const button of
      $("aq-tier-tabs").querySelectorAll("button")) {

      button.classList.toggle(
        "selected",
        Number(button.dataset.aqTier) === tier
      );
    }

    const target = $("aq-admin-lines");
    target.replaceChildren();

    const roster = members.filter(
      member => Number(member.group_no) === group
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
      free.textContent = "🟢 Livre";
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

        option.textContent = member.name +
          (assignedElsewhere ? " (já atribuído)" : "");

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
      `;

      button.onclick = async () => {
        if (busy) return;

        busy = true;
        button.disabled = true;

        const chosen = select.value === ""
          ? null
          : Number(select.value);

        status(
          "⏳ A guardar G" + group +
          " · Tier " + tier +
          " · Linha " + line + "…"
        );

        try {
          await save(line, chosen);
          await load();

          status(
            "✓ Caminho guardado na D1. G" + group +
            " · Tier " + tier +
            " · Linha " + line
          );

        } catch (error) {
          status("⚠️ " + error.message);
          button.disabled = false;

        } finally {
          busy = false;
        }
      };

      card.append(heading, select, button);
      target.append(card);
    }

    if (!roster.length) {
      status(
        "⚠️ Nenhum jogador encontrado no G" + group +
        ". Confirma /api/members."
      );
    }
  }

  async function load() {
    status("⏳ A carregar D1…");

    try {
      const [aq, membersData] = await Promise.all([
        get("/api/aq-assignments"),
        get("/api/members")
      ]);

      if (
        !Array.isArray(aq.items) ||
        !Array.isArray(membersData.items)
      ) {
        throw Error("Dados inválidos da API.");
      }

      assignments = aq.items;
      members = membersData.items;

      render();

      const count = assignments.filter(item =>
        Number(item.group_no) === group &&
        Number(item.tier) === tier
      ).length;

      if (members.some(
        member => Number(member.group_no) === group
      )) {
        status(
          "✓ G" + group +
          " · Tier " + tier +
          " · " + count + " linhas atribuídas."
        );
      }

    } catch (error) {
      status("⚠️ " + error.message);
    }
  }

  $("aq-group-tabs").onclick = event => {
    const button = event.target.closest(
      "[data-aq-group]"
    );

    if (!button || busy) return;

    group = Number(button.dataset.aqGroup);
    render();
  };

  $("aq-tier-tabs").onclick = event => {
    const button = event.target.closest(
      "[data-aq-tier]"
    );

    if (!button || busy) return;

    tier = Number(button.dataset.aqTier);
    render();
  };

  $("aq-admin-refresh").onclick = load;

  load();
})();
