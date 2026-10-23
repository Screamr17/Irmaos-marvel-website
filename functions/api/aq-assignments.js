
const LIMITS = { 1: 7, 2: 9, 3: 8 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function b64(value) {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  return Uint8Array.from(
    atob(
      normalized +
      "=".repeat((4 - normalized.length % 4) % 4)
    ),
    character => character.charCodeAt(0)
  );
}

function decode(value) {
  return JSON.parse(
    new TextDecoder().decode(b64(value))
  );
}

// Verificação de segurança dos oficiais
async function identity(request, env) {
  try {
    const token = request.headers.get(
      "Cf-Access-Jwt-Assertion"
    );

    if (
      !token ||
      !env.ACCESS_TEAM_DOMAIN ||
      !env.ACCESS_AUD
    ) {
      return null;
    }

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [h, p, s] = parts;

    const header = decode(h);
    const payload = decode(p);

    const domain = env.ACCESS_TEAM_DOMAIN
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");

    const issuer = "https://" + domain;
    const now = Math.floor(Date.now() / 1000);

    if (
      payload.iss !== issuer ||
      !Array.isArray(payload.aud) ||
      !payload.aud.includes(env.ACCESS_AUD) ||
      !payload.exp ||
      payload.exp <= now ||
      (payload.nbf && payload.nbf > now) ||
      !payload.email ||
      !header.kid ||
      header.alg !== "RS256"
    ) {
      return null;
    }

    const response = await fetch(
      issuer + "/cdn-cgi/access/certs"
    );

    if (!response.ok) return null;

    const keys = await response.json();

    const jwk = (keys.keys || []).find(
      key =>
        key.kid === header.kid &&
        key.kty === "RSA"
    );

    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256"
      },
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

    const email = payload.email
      .trim()
      .toLowerCase();

    const allowed = (env.OFFICER_EMAILS || "")
      .split(",")
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);

    return allowed.includes(email)
      ? email
      : null;

  } catch (error) {
    console.error("AQ Access:", error);
    return null;
  }
}

function validPosition(group, tier, line) {
  return (
    Number.isSafeInteger(group) &&
    group >= 1 &&
    group <= 3 &&
    Number.isSafeInteger(tier) &&
    tier >= 1 &&
    tier <= 3 &&
    Number.isSafeInteger(line) &&
    line >= 1 &&
    line <= LIMITS[tier]
  );
}

async function readAssignments(db) {
  const result = await db.prepare(`
    SELECT
      group_no,
      tier,
      line_no,
      member_id
    FROM aq_assignments
    ORDER BY group_no, tier, line_no
  `).all();

  return result.results || [];
}

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return json({
      error: "Base de dados D1 indisponível."
    }, 503);
  }

  if (
    !["GET", "POST", "DELETE"].includes(request.method)
  ) {
    return json({
      error: "Método não permitido."
    }, 405);
  }

  try {
    // Leitura pública
    if (request.method === "GET") {
      const items = await readAssignments(env.DB);

      return json({
        ok: true,
        limits: LIMITS,
        items
      });
    }

    // Gravação reservada aos oficiais
    const officer = await identity(request, env);

    if (!officer) {
      return json({
        error: "Acesso reservado aos oficiais."
      }, 403);
    }

    let data;

    try {
      data = await request.json();
    } catch {
      return json({
        error: "JSON inválido."
      }, 400);
    }

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return json({
        error: "Dados inválidos."
      }, 400);
    }

    const group = Number(data.group_no);
    const tier = Number(data.tier);
    const line = Number(data.line_no);

    if (!validPosition(group, tier, line)) {
      return json({
        error: "Grupo, Tier ou linha inválidos."
      }, 400);
    }

    // Libertar uma linha
    if (
      request.method === "DELETE" ||
      data.member_id === null ||
      data.member_id === ""
    ) {
      await env.DB.prepare(`
        DELETE FROM aq_assignments
        WHERE group_no = ?
          AND tier = ?
          AND line_no = ?
      `).bind(group, tier, line).run();

      return json({
        ok: true,
        message: "Linha livre."
      });
    }

    const memberId = Number(data.member_id);

    if (
      !Number.isSafeInteger(memberId) ||
      memberId <= 0
    ) {
      return json({
        error: "Jogador inválido."
      }, 400);
    }

    // Confirma que o jogador existe no grupo
    const member = await env.DB.prepare(`
      SELECT id, name, group_no
      FROM alliance_members
      WHERE id = ?
        AND group_no = ?
      LIMIT 1
    `).bind(memberId, group).first();

    if (!member) {
      return json({
        error: "Jogador não encontrado neste grupo."
      }, 400);
    }

    // Impede o mesmo jogador em duas linhas
    const existing = await env.DB.prepare(`
      SELECT line_no
      FROM aq_assignments
      WHERE group_no = ?
        AND tier = ?
        AND member_id = ?
        AND line_no <> ?
      LIMIT 1
    `).bind(
      group,
      tier,
      memberId,
      line
    ).first();

    if (existing) {
      return json({
        error:
          member.name +
          " já está na linha " +
          existing.line_no +
          " deste Tier."
      }, 409);
    }

    try {
      await env.DB.prepare(`
        INSERT INTO aq_assignments (
          group_no,
          tier,
          line_no,
          member_id,
          updated_at
        )
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(group_no, tier, line_no)
        DO UPDATE SET
          member_id = excluded.member_id,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        group,
        tier,
        line,
        memberId
      ).run();

    } catch (error) {
      if (
        String(error.message || "")
          .includes("UNIQUE constraint failed")
      ) {
        return json({
          error:
            "Este jogador já ocupa outra linha " +
            "do mesmo Tier."
        }, 409);
      }

      throw error;
    }

    return json({
      ok: true,
      message: "Caminho guardado.",
      assignment: {
        group_no: group,
        tier,
        line_no: line,
        member_id: memberId,
        member_name: member.name
      },
      updated_by: officer
    });

  } catch (error) {
    console.error("AQ API:", error);

    return json({
      error:
        "Erro no servidor. Verifica as tabelas " +
        "da D1 e a configuração Cloudflare."
    }, 500);
  }
}
