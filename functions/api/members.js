
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

export async function onRequest({ request, env }) {
  try {
    if (!env.DB)
      return json({ error: "D1 não configurada." }, 503);

    const email = await identity(request, env);

    if (!email)
      return json({
        error: "Não autorizado. Confirma Cloudflare Access e OFFICER_EMAILS."
      }, 403);

    if (request.method === "GET") {
      const data = await env.DB.prepare(
        `SELECT id, group_no, position, name, prestige, role, updated_at
         FROM alliance_members
         ORDER BY group_no, position, id`
      ).all();

      return json({ items: data.results || [], email });
    }

    if (!["POST", "PUT", "DELETE"].includes(request.method))
      return json({ error: "Método não permitido." }, 405);

    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object")
      return json({ error: "Dados inválidos." }, 400);

    // TROCAR DOIS JOGADORES ENTRE GRUPOS
    if (request.method === "POST" && body.action === "swap") {
      const first = Number(body.first_id);
      const second = Number(body.second_id);

      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(second) ||
        first < 1 ||
        second < 1 ||
        first === second
      ) {
        return json({
          error: "Escolhe dois jogadores diferentes."
        }, 400);
      }

      const rows = await env.DB.prepare(
        `SELECT id, group_no, position, name
         FROM alliance_members
         WHERE id IN (?, ?)`
      ).bind(first, second).all();

      const a = (rows.results || []).find(x => x.id === first);
      const b = (rows.results || []).find(x => x.id === second);

      if (!a || !b)
        return json({
          error: "Jogador não encontrado. Atualiza a lista."
        }, 404);

      if (a.group_no === b.group_no)
        return json({
          error: "Escolhe jogadores de grupos diferentes."
        }, 400);

      // As duas alterações são executadas numa transação D1.
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE alliance_members
           SET group_no = ?, position = ?,
               updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND group_no = ?`
        ).bind(b.group_no, b.position, email, a.id, a.group_no),

        env.DB.prepare(
          `UPDATE alliance_members
           SET group_no = ?, position = ?,
               updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND group_no = ?`
        ).bind(a.group_no, a.position, email, b.id, b.group_no)
      ]);

      if (results.some(r => r.meta?.changes !== 1))
        return json({
          error: "A lista foi alterada. Atualiza e tenta novamente."
        }, 409);

      return json({
        ok: true,
        first_id: first,
        second_id: second
      });
    }

    const id = Number(body.id);

    // APAGAR JOGADOR
    if (request.method === "DELETE") {
      if (!Number.isSafeInteger(id) || id < 1)
        return json({ error: "ID inválido." }, 400);

      const result = await env.DB.prepare(
        "DELETE FROM alliance_members WHERE id = ?"
      ).bind(id).run();

      return json({ ok: result.meta.changes > 0 });
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
      if (!Number.isSafeInteger(id) || id < 1)
        return json({ error: "ID inválido." }, 400);

      const previous = await env.DB.prepare(
        "SELECT group_no FROM alliance_members WHERE id = ?"
      ).bind(id).first();

      if (!previous)
        return json({ error: "Jogador não encontrado." }, 404);

      if (previous.group_no !== group) {
        const count = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM alliance_members WHERE group_no = ?"
        ).bind(group).first();

        if (count.n >= 10)
          return json({
            error: "Grupo completo. Usa a opção Trocar dois jogadores."
          }, 409);

        const result = await env.DB.prepare(
          `UPDATE alliance_members
           SET name = ?, prestige = ?, role = ?,
               group_no = ?,
               position = (
                 SELECT COALESCE(MAX(position), 0) + 1
                 FROM alliance_members
                 WHERE group_no = ?
               ),
               updated_by = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(
          name, prestige, role, group, group, email, id
        ).run();

        return json({ ok: result.meta.changes > 0 });
      }

      const result = await env.DB.prepare(
        `UPDATE alliance_members
         SET name = ?, prestige = ?, role = ?,
             updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(name, prestige, role, email, id).run();

      return json({ ok: result.meta.changes > 0 });
    }

    // ADICIONAR JOGADOR
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM alliance_members WHERE group_no = ?"
    ).bind(group).first();

    if (count.n >= 10)
      return json({
        error: "Este grupo já tem 10 jogadores."
      }, 409);

    const result = await env.DB.prepare(
      `INSERT INTO alliance_members
       (group_no, position, name, prestige, role, updated_by)
       VALUES (
         ?,
         (SELECT COALESCE(MAX(position), 0) + 1
          FROM alliance_members WHERE group_no = ?),
         ?, ?, ?, ?
       )`
    ).bind(
      group, group, name, prestige, role, email
    ).run();

    return json({
      ok: true,
      id: result.meta.last_row_id
    }, 201);

  } catch (error) {
    console.error("Members API:", error);

    return json({
      error: "Erro na API. Confirma a configuração D1 e Cloudflare Access."
    }, 500);
  }
}
