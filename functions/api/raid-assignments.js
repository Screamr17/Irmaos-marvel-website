
const MAPS = ["normal", "nightmare"];
const PATHS = ["A", "B", "C"];
const ROLES = ["assalto", "vanguarda", "tatico"];

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

// Verifica a identidade dos oficiais com Cloudflare Access
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
    console.error("RAID Access:", error);
    return null;
  }
}

function validPosition(group, map, path, role) {
  return (
    Number.isSafeInteger(group) &&
    group >= 1 &&
    group <= 3 &&
    MAPS.includes(map) &&
    PATHS.includes(path) &&
    ROLES.includes(role)
  );
}

async function readAssignments(db) {
  const result = await db.prepare(`
    SELECT
      a.group_no,
      a.map_type,
      a.path,
      a.role,
      a.member_id,
      m.name AS member_name
    FROM raid_assignments a
    LEFT JOIN alliance_members m
      ON m.id = a.member_id
    ORDER BY
      a.group_no,
      a.map_type,
      a.path,
      CASE a.role
        WHEN 'assalto' THEN 1
        WHEN 'vanguarda' THEN 2
        WHEN 'tatico' THEN 3
        ELSE 4
      END
  `).all();

  return result.results || [];
}

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return json({
      error: "Base de dados D1 indisponível."
    }, 503);
  }

  if (!["GET", "POST", "DELETE"].includes(request.method)) {
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
        maps: MAPS,
        paths: PATHS,
        roles: ROLES,
        items
      });
    }

    // Apenas oficiais autorizados podem alterar
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
    const map = String(data.map_type || "")
      .trim()
      .toLowerCase();
    const path = String(data.path || "")
      .trim()
      .toUpperCase();
    const role = String(data.role || "")
      .trim()
      .toLowerCase();

    if (!validPosition(group, map, path, role)) {
      return json({
        error: "Grupo, mapa, caminho ou função inválidos."
      }, 400);
    }

    // Remover atribuição
    if (
      request.method === "DELETE" ||
      data.member_id === null ||
      data.member_id === ""
    ) {
      await env.DB.prepare(`
        DELETE FROM raid_assignments
        WHERE group_no = ?
          AND map_type = ?
          AND path = ?
          AND role = ?
      `).bind(
        group,
        map,
        path,
        role
      ).run();

      return json({
        ok: true,
        message: "Atribuição removida."
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

    // Confirma que o jogador pertence ao grupo
    const member = await env.DB.prepare(`
      SELECT id, name, group_no
      FROM alliance_members
      WHERE id = ?
        AND group_no = ?
      LIMIT 1
    `).bind(
      memberId,
      group
    ).first();

    if (!member) {
      return json({
        error: "Jogador não encontrado neste grupo."
      }, 400);
    }

    // Impede o mesmo jogador em duas posições
    // do mesmo grupo e mapa
    const existing = await env.DB.prepare(`
      SELECT path, role
      FROM raid_assignments
      WHERE group_no = ?
        AND map_type = ?
        AND member_id = ?
        AND NOT (path = ? AND role = ?)
      LIMIT 1
    `).bind(
      group,
      map,
      memberId,
      path,
      role
    ).first();

    if (existing) {
      return json({
        error:
          member.name +
          " já está atribuído ao caminho " +
          existing.path +
          " (" + existing.role + ") neste mapa."
      }, 409);
    }

    try {
      await env.DB.prepare(`
        INSERT INTO raid_assignments (
          group_no,
          map_type,
          path,
          role,
          member_id,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(group_no, map_type, path, role)
        DO UPDATE SET
          member_id = excluded.member_id,
          updated_at = CURRENT_TIMESTAMP
      `).bind(
        group,
        map,
        path,
        role,
        memberId
      ).run();

    } catch (error) {
      if (
        String(error.message || "")
          .includes("UNIQUE constraint failed")
      ) {
        return json({
          error:
            "Este jogador já ocupa outra posição " +
            "no mesmo mapa."
        }, 409);
      }

      throw error;
    }

    return json({
      ok: true,
      message: "Atribuição RAID guardada.",
      assignment: {
        group_no: group,
        map_type: map,
        path,
        role,
        member_id: memberId,
        member_name: member.name
      },
      updated_by: officer
    });

  } catch (error) {
    console.error("RAID API:", error);

    return json({
      error:
        "Erro no servidor. Verifica a tabela " +
        "raid_assignments e a configuração D1."
    }, 500);
  }
}
