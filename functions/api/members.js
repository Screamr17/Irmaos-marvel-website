
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });

function b64(s) {
  const a = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(a + "=".repeat((4 - a.length % 4) % 4)),
    c => c.charCodeAt(0)
  );
}

function decode(s) {
  return JSON.parse(new TextDecoder().decode(b64(s)));
}

async function identity(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");

  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
    return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [h, p, s] = parts;
  const header = decode(h);
  const payload = decode(p);

  const domain = env.ACCESS_TEAM_DOMAIN
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const issuer = "https://" + domain;

  if (
    payload.iss !== issuer ||
    !Array.isArray(payload.aud) ||
    !payload.aud.includes(env.ACCESS_AUD) ||
    !payload.exp ||
    payload.exp <= Date.now() / 1000 ||
    !payload.email ||
    !header.kid ||
    header.alg !== "RS256"
  ) return null;

  const res = await fetch(issuer + "/cdn-cgi/access/certs");
  if (!res.ok) return null;

  const keys = await res.json();
  const jwk = (keys.keys || []).find(
    k => k.kid === header.kid && k.kty === "RSA"
  );

  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64(s),
    new TextEncoder().encode(h + "." + p)
  );

  if (!valid) return null;

  const email = payload.email.toLowerCase();
  const allow = (env.OFFICER_EMAILS || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  return allow.includes(email) ? email : null;
}

function validId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function snapshot(row) {
  return {
    id: row.id,
    name: row.name,
    group_no: row.group_no,
    position: row.position,
    prestige: row.prestige,
    role: row.role
  };
}

const fields = [
  "id", "name", "group_no",
  "position", "prestige", "role"
];

function same(a, b) {
  return !!a && !!b && fields.every(k => a[k] === b[k]);
}

function historyStatement(env, action, member, details, email) {
  return env.DB.prepare(
    `INSERT INTO member_history
     (action, member_id, member_name, details, officer_email)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    action,
    member.id,
    member.name,
    JSON.stringify(details),
    email
  );
}

function getMember(env, id) {
  return env.DB.prepare(
    `SELECT id, group_no, position, name, prestige, role
     FROM alliance_members WHERE id = ?`
  ).bind(id).first();
}

function setMember(env, row, email) {
  return env.DB.prepare(
    `UPDATE alliance_members
     SET name = ?, group_no = ?, position = ?,
         prestige = ?, role = ?, updated_by = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(
    row.name, row.group_no, row.position,
    row.prestige, row.role, email, row.id
  );
}

function countGroup(env, group) {
  return env.DB.prepare(
    "SELECT COUNT(*) AS n FROM alliance_members WHERE group_no = ?"
  ).bind(group).first();
}

function maxPosition(env, group) {
  return env.DB.prepare(
    `SELECT COALESCE(MAX(position), 0) AS n
     FROM alliance_members WHERE group_no = ?`
  ).bind(group).first();
}

// DESFAZER ALTERAÇÕES
async function undo(env, email, historyId) {
  const record = await env.DB.prepare(
    "SELECT * FROM member_history WHERE id = ?"
  ).bind(historyId).first();

  if (
    !record ||
    !["create", "update", "delete", "swap"].includes(record.action)
  ) {
    return json({
      error: "Alteração não encontrada ou não reversível."
    }, 404);
  }

  const prior = await env.DB.prepare(
    `SELECT id FROM member_history
     WHERE action = 'undo'
       AND json_extract(details, '$.original_history_id') = ?
     LIMIT 1`
  ).bind(historyId).first();

  if (prior)
    return json({ error: "Esta alteração já foi desfeita." }, 409);

  let details;

  try {
    details = JSON.parse(record.details);
  } catch {
    return json({ error: "Histórico inválido." }, 409);
  }

  const before = details.before;
  const after = details.after;

  // DESFAZER TROCA DE JOGADORES
  if (record.action === "swap") {
    const otherId = validId(details.other_member_id);

    if (!before || !after || !otherId)
      return json({ error: "Dados da troca incompletos." }, 409);

    const otherRecord = await env.DB.prepare(
      `SELECT * FROM member_history
       WHERE action = 'swap'
         AND member_id = ?
         AND id BETWEEN ? AND ?
       ORDER BY id DESC`
    ).bind(otherId, historyId - 1, historyId + 1).all();

    const pair = (otherRecord.results || []).find(r => {
      try {
        const d = JSON.parse(r.details);
        return (
          d.other_member_id === record.member_id &&
          r.officer_email === record.officer_email &&
          r.created_at === record.created_at
        );
      } catch {
        return false;
      }
    });

    if (!pair)
      return json({
        error: "Não foi possível identificar a outra metade da troca."
      }, 409);

    const pairUndo = await env.DB.prepare(
      `SELECT id FROM member_history
       WHERE action = 'undo'
         AND json_extract(details, '$.original_history_id') = ?
       LIMIT 1`
    ).bind(pair.id).first();

    if (pairUndo)
      return json({ error: "Esta troca já foi desfeita." }, 409);

    const otherDetails = JSON.parse(pair.details);
    const a = await getMember(env, record.member_id);
    const b = await getMember(env, otherId);

    if (!same(a, after) || !same(b, otherDetails.after))
      return json({
        error: "Os jogadores foram alterados depois da troca. Não é seguro desfazer."
      }, 409);

    await env.DB.batch([
      setMember(env, before, email),
      setMember(env, otherDetails.before, email),

      historyStatement(
        env, "undo", before,
        {
          original_history_id: historyId,
          paired_history_id: pair.id,
          undo_action: "swap",
          before: after,
          after: before
        },
        email
      ),

      historyStatement(
        env, "undo", otherDetails.before,
        {
          original_history_id: pair.id,
          paired_history_id: historyId,
          undo_action: "swap",
          before: otherDetails.after,
          after: otherDetails.before
        },
        email
      )
    ]);

    return json({ ok: true, action: "swap" });
  }

  const current = await getMember(env, record.member_id);

  // DESFAZER ADIÇÃO
  if (record.action === "create") {
    if (!same(current, after))
      return json({
        error: "Este jogador foi alterado entretanto. Não é seguro desfazer."
      }, 409);

    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM alliance_members WHERE id = ?"
      ).bind(after.id),

      historyStatement(
        env, "undo", after,
        {
          original_history_id: historyId,
          undo_action: "create",
          before: after
        },
        email
      )
    ]);
  }

  // DESFAZER ELIMINAÇÃO
  else if (record.action === "delete") {
    if (!before || current)
      return json({
        error: "O jogador já existe ou o histórico está incompleto."
      }, 409);

    const count = await countGroup(env, before.group_no);

    if (count.n >= 10)
      return json({
        error: "O grupo original está completo. Não é possível restaurar."
      }, 409);

    const occupied = await env.DB.prepare(
      `SELECT id FROM alliance_members
       WHERE group_no = ? AND position = ?`
    ).bind(before.group_no, before.position).first();

    if (occupied)
      return json({
        error: "A posição original está ocupada. Ajusta os grupos antes de restaurar."
      }, 409);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO alliance_members
         (id, group_no, position, name, prestige,
          role, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(
        before.id, before.group_no, before.position,
        before.name, before.prestige, before.role, email
      ),

      historyStatement(
        env, "undo", before,
        {
          original_history_id: historyId,
          undo_action: "delete",
          after: before
        },
        email
      )
    ]);
  }

  // DESFAZER EDIÇÃO
  else {
    if (!before || !same(current, after))
      return json({
        error: "O jogador foi alterado entretanto. Não é seguro desfazer."
      }, 409);

    if (before.group_no !== after.group_no) {
      const count = await countGroup(env, before.group_no);

      if (count.n >= 10)
        return json({
          error: "O grupo original está completo. Não é possível desfazer."
        }, 409);
    }

    const occupied = await env.DB.prepare(
      `SELECT id FROM alliance_members
       WHERE group_no = ? AND position = ? AND id <> ?`
    ).bind(
      before.group_no, before.position, before.id
    ).first();

    if (occupied)
      return json({
        error: "A posição anterior está ocupada. Não é possível desfazer."
      }, 409);

    await env.DB.batch([
      setMember(env, before, email),

      historyStatement(
        env, "undo", before,
        {
          original_history_id: historyId,
          undo_action: "update",
          before: after,
          after: before
        },
        email
      )
    ]);
  }

  return json({ ok: true, action: record.action });
}

// API PRINCIPAL
export async function onRequest({ request, env }) {
  try {
    if (!env.DB)
      return json({ error: "D1 não configurada." }, 503);

    const email = await identity(request, env);

    if (!email)
      return json({
        error: "Não autorizado. Confirma Cloudflare Access e OFFICER_EMAILS."
      }, 403);

    const url = new URL(request.url);

    // CONSULTAR HISTÓRICO
    if (
      request.method === "GET" &&
      url.searchParams.get("action") === "history"
    ) {
      const result = await env.DB.prepare(
        `SELECT id, action, member_id, member_name,
                details, officer_email, created_at
         FROM member_history
         ORDER BY id DESC
         LIMIT 100`
      ).all();

      return json({ items: result.results || [], email });
    }

    // CONSULTAR JOGADORES
    if (request.method === "GET") {
      const result = await env.DB.prepare(
        `SELECT id, group_no, position, name,
                prestige, role, updated_at
         FROM alliance_members
         ORDER BY group_no, position, id`
      ).all();

      return json({ items: result.results || [], email });
    }

    if (!["POST", "PUT", "DELETE"].includes(request.method))
      return json({ error: "Método não permitido." }, 405);

    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body))
      return json({ error: "Dados inválidos." }, 400);

    // PEDIDO PARA DESFAZER
    if (
      request.method === "POST" &&
      body.action === "undo"
    ) {
      const historyId = validId(body.history_id);

      if (!historyId)
        return json({ error: "ID do histórico inválido." }, 400);

      return await undo(env, email, historyId);
    }

    // TROCAR DOIS JOGADORES
    if (
      request.method === "POST" &&
      body.action === "swap"
    ) {
      const first = validId(body.first_id);
      const second = validId(body.second_id);

      if (!first || !second || first === second)
        return json({
          error: "Escolhe dois jogadores diferentes."
        }, 400);

      const result = await env.DB.prepare(
        `SELECT id, group_no, position, name, prestige, role
         FROM alliance_members
         WHERE id IN (?, ?)`
      ).bind(first, second).all();

      const a = (result.results || []).find(x => x.id === first);
      const b = (result.results || []).find(x => x.id === second);

      if (!a || !b)
        return json({
          error: "Jogador não encontrado. Atualiza a lista."
        }, 404);

      if (a.group_no === b.group_no)
        return json({
          error: "Escolhe jogadores de grupos diferentes."
        }, 400);

      const beforeA = snapshot(a);
      const beforeB = snapshot(b);

      const afterA = {
        ...beforeA,
        group_no: b.group_no,
        position: b.position
      };

      const afterB = {
        ...beforeB,
        group_no: a.group_no,
        position: a.position
      };

      await env.DB.batch([
        setMember(env, afterA, email),
        setMember(env, afterB, email),

        historyStatement(
          env, "swap", a,
          {
            before: beforeA,
            after: afterA,
            other_member: b.name,
            other_member_id: b.id
          },
          email
        ),

        historyStatement(
          env, "swap", b,
          {
            before: beforeB,
            after: afterB,
            other_member: a.name,
            other_member_id: a.id
          },
          email
        )
      ]);

      return json({
        ok: true,
        first_id: first,
        second_id: second
      });
    }

    const id = validId(body.id);

    // ELIMINAR JOGADOR
    if (request.method === "DELETE") {
      if (!id)
        return json({ error: "ID inválido." }, 400);

      const old = await getMember(env, id);

      if (!old)
        return json({ error: "Jogador não encontrado." }, 404);

      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM alliance_members WHERE id = ?"
        ).bind(id),

        historyStatement(
          env, "delete", old,
          { before: snapshot(old) },
          email
        )
      ]);

      return json({ ok: true });
    }

    const name = String(body.name || "").trim();
    const group = Number(body.group_no);
    const prestige = Number(body.prestige);
    const role = String(body.role || "");

    if (
      !name ||
      name.length > 100 ||
      ![1, 2, 3].includes(group) ||
      !Number.isSafeInteger(prestige) ||
      prestige < 0 ||
      prestige > 9999999 ||
      !["", "OFICIAL", "LÍDER"].includes(role)
    ) {
      return json({
        error: "Confirma nome, grupo, prestígio e cargo."
      }, 400);
    }

    // EDITAR JOGADOR
    if (request.method === "PUT") {
      if (!id)
        return json({ error: "ID inválido." }, 400);

      const old = await getMember(env, id);

      if (!old)
        return json({ error: "Jogador não encontrado." }, 404);

      let position = old.position;

      if (old.group_no !== group) {
        const count = await countGroup(env, group);

        if (count.n >= 10)
          return json({
            error: "Grupo completo. Usa a opção Trocar dois jogadores."
          }, 409);

        const max = await maxPosition(env, group);
        position = max.n + 1;
      }

      const before = snapshot(old);

      const after = {
        id,
        name,
        group_no: group,
        position,
        prestige,
        role
      };

      await env.DB.batch([
        setMember(env, after, email),

        historyStatement(
          env, "update", after,
          { before, after },
          email
        )
      ]);

      return json({ ok: true });
    }

    // ADICIONAR JOGADOR
    const count = await countGroup(env, group);

    if (count.n >= 10)
      return json({
        error: "Este grupo já tem 10 jogadores."
      }, 409);

    const max = await maxPosition(env, group);
    const position = max.n + 1;

    const created = await env.DB.prepare(
      `INSERT INTO alliance_members
       (group_no, position, name, prestige, role, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING id, group_no, position, name, prestige, role`
    ).bind(
      group, position, name, prestige, role, email
    ).first();

    if (!created)
      throw new Error("Falha ao criar jogador.");

    await historyStatement(
      env,
      "create",
      created,
      { after: snapshot(created) },
      email
    ).run();

    return json({ ok: true, id: created.id }, 201);

  } catch (error) {
    console.error("Members API:", error);

    return json({
      error: "Erro na API. Confirma a tabela member_history e a configuração D1."
    }, 500);
  }
}
