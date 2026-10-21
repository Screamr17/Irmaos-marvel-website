
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

    // CONSULTAR HISTÓRICO (APENAS OFICIAIS)
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

    // TROCAR DOIS JOGADORES
    if (request.method === "POST" && body.action === "swap") {
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

      // Atualizações e histórico na mesma transação D1.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE alliance_members
           SET group_no = ?, position = ?,
               updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(
          afterA.group_no, afterA.position, email, a.id
        ),

        env.DB.prepare(
          `UPDATE alliance_members
           SET group_no = ?, position = ?,
               updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(
          afterB.group_no, afterB.position, email, b.id
        ),

        historyStatement(
          env,
          "swap",
          a,
          {
            before: beforeA,
            after: afterA,
            other_member: b.name,
            other_member_id: b.id
          },
          email
        ),

        historyStatement(
          env,
          "swap",
          b,
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

      const old = await env.DB.prepare(
        `SELECT id, group_no, position, name, prestige, role
         FROM alliance_members WHERE id = ?`
      ).bind(id).first();

      if (!old)
        return json({ error: "Jogador não encontrado." }, 404);

      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM alliance_members WHERE id = ?"
        ).bind(id),

        historyStatement(
          env,
          "delete",
          old,
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

      const old = await env.DB.prepare(
        `SELECT id, group_no, position, name, prestige, role
         FROM alliance_members WHERE id = ?`
      ).bind(id).first();

      if (!old)
        return json({ error: "Jogador não encontrado." }, 404);

      let position = old.position;

      if (old.group_no !== group) {
        const count = await env.DB.prepare(
          `SELECT COUNT(*) AS n
           FROM alliance_members WHERE group_no = ?`
        ).bind(group).first();

        if (count.n >= 10)
          return json({
            error: "Grupo completo. Usa a opção Trocar dois jogadores."
          }, 409);

        const max = await env.DB.prepare(
          `SELECT COALESCE(MAX(position), 0) AS n
           FROM alliance_members WHERE group_no = ?`
        ).bind(group).first();

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
        env.DB.prepare(
          `UPDATE alliance_members
           SET name = ?, group_no = ?, position = ?,
               prestige = ?, role = ?, updated_by = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(
          name, group, position, prestige, role, email, id
        ),

        historyStatement(
          env,
          "update",
          after,
          { before, after },
          email
        )
      ]);

      return json({ ok: true });
    }

    // ADICIONAR JOGADOR
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n
       FROM alliance_members WHERE group_no = ?`
    ).bind(group).first();

    if (count.n >= 10)
      return json({
        error: "Este grupo já tem 10 jogadores."
      }, 409);

    const max = await env.DB.prepare(
      `SELECT COALESCE(MAX(position), 0) AS n
       FROM alliance_members WHERE group_no = ?`
    ).bind(group).first();

    const position = max.n + 1;

    // RETURNING permite registar o ID correto no histórico.
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
