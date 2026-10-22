
/*
 * IRMÃOS MARVEL
 * Hall da Fama BG — API protegida
 *
 * Ficheiro: functions/api/bg-seasons.js
 *
 * GET    - Listar temporadas
 * POST   - Criar temporada
 * PUT    - Editar temporada
 * DELETE - Eliminar temporada
 *
 * Autenticação: Cloudflare Access
 * Base de dados: Cloudflare D1 (env.DB)
 */

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

/* AUTENTICAÇÃO CLOUDFLARE ACCESS */

function b64(value) {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded =
    normalized + "=".repeat(
      (4 - normalized.length % 4) % 4
    );

  return Uint8Array.from(
    atob(padded),
    c => c.charCodeAt(0)
  );
}

function decode(value) {
  return JSON.parse(
    new TextDecoder().decode(b64(value))
  );
}

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

    if (parts.length !== 3) {
      return null;
    }

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
    ) {
      return null;
    }

    const response = await fetch(
      issuer + "/cdn-cgi/access/certs"
    );

    if (!response.ok) {
      return null;
    }

    const keys = await response.json();

    const jwk = (keys.keys || []).find(
      key =>
        key.kid === header.kid &&
        key.kty === "RSA"
    );

    if (!jwk) {
      return null;
    }

    const cryptoKey = await crypto.subtle.importKey(
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
      cryptoKey,
      b64(s),
      new TextEncoder().encode(h + "." + p)
    );

    if (!valid) {
      return null;
    }

    const email = payload.email.toLowerCase();

    const allowed = (env.OFFICER_EMAILS || "")
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    return allowed.includes(email)
      ? email
      : null;

  } catch (error) {
    console.error("BG Access authentication:", error);
    return null;
  }
}

/* VALIDAÇÃO DOS RESULTADOS */

function normalize(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error("Dados inválidos.");
  }

  const name = String(body.name ?? "").trim();

  if (!name || name.length > 80) {
    throw new Error(
      "O nome da temporada deve ter entre 1 e 80 caracteres."
    );
  }

  const players = [];

  for (let position = 1; position <= 3; position++) {
    const playerName = String(
      body["player_" + position] ?? ""
    ).trim();

    const rawPoints = body["points_" + position];

    if (
      !playerName ||
      playerName.length > 100
    ) {
      throw new Error(
        "Verifica o nome do " +
        position +
        ".º lugar."
      );
    }

    if (
      rawPoints === "" ||
      rawPoints === null ||
      rawPoints === undefined ||
      !Number.isSafeInteger(Number(rawPoints)) ||
      Number(rawPoints) < 0
    ) {
      throw new Error(
        "Os pontos do " +
        position +
        ".º lugar são inválidos."
      );
    }

    players.push({
      name: playerName,
      points: Number(rawPoints)
    });
  }

  const uniquePlayers = new Set(
    players.map(p => p.name.toLowerCase())
  );

  if (uniquePlayers.size !== 3) {
    throw new Error(
      "Os três jogadores devem ser diferentes."
    );
  }

  return { name, players };
}

function validId(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const id = Number(value);

  return Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

/* FORMATO DOS RESULTADOS */

function formatRow(row) {
  return {
    id: row.id,
    name: row.name,
    players: [
      {
        position: 1,
        name: row.player_1,
        points: row.points_1
      },
      {
        position: 2,
        name: row.player_2,
        points: row.points_2
      },
      {
        position: 3,
        name: row.player_3,
        points: row.points_3
      }
    ],
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/* API ADMINISTRATIVA */

async function handle({ request, env }) {
  const email = await identity(request, env);

  if (!email) {
    return json({
      error: "Acesso reservado aos oficiais autorizados."
    }, 403);
  }

  if (!env.DB) {
    return json({
      error: "Ligação à base de dados D1 indisponível."
    }, 503);
  }

  const method = request.method;

  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
    return json({
      error: "Método não permitido."
    }, 405);
  }

  try {

    /* LISTAR TEMPORADAS */

    if (method === "GET") {
      const result = await env.DB.prepare(`
        SELECT
          id,
          name,
          player_1,
          points_1,
          player_2,
          points_2,
          player_3,
          points_3,
          created_at,
          updated_at
        FROM bg_seasons
        ORDER BY id DESC
      `).all();

      return json({
        email,
        items: (result.results || []).map(formatRow)
      });
    }

    const body = await request.json().catch(
      () => null
    );

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return json({
        error: "Envia dados JSON válidos."
      }, 400);
    }

    /* ELIMINAR TEMPORADA */

    if (method === "DELETE") {
      const id = validId(body.id);

      if (!id) {
        return json({
          error: "ID inválido."
        }, 400);
      }

      const result = await env.DB.prepare(
        "DELETE FROM bg_seasons WHERE id = ?"
      )
        .bind(id)
        .run();

      if (!result.meta?.changes) {
        return json({
          error: "Temporada não encontrada."
        }, 404);
      }

      return json({
        ok: true
      });
    }

    /* VALIDAR CRIAÇÃO OU EDIÇÃO */

    let data;

    try {
      data = normalize(body);
    } catch (error) {
      return json({
        error: error.message
      }, 400);
    }

    const p = data.players;

    /* CRIAR TEMPORADA */

    if (method === "POST") {
      const result = await env.DB.prepare(`
        INSERT INTO bg_seasons (
          name,
          player_1,
          points_1,
          player_2,
          points_2,
          player_3,
          points_3
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          data.name,
          p[0].name,
          p[0].points,
          p[1].name,
          p[1].points,
          p[2].name,
          p[2].points
        )
        .run();

      return json({
        ok: true,
        id: result.meta?.last_row_id
      }, 201);
    }

    /* EDITAR TEMPORADA */

    if (method === "PUT") {
      const id = validId(body.id);

      if (!id) {
        return json({
          error: "ID inválido."
        }, 400);
      }

      const existing = await env.DB.prepare(
        "SELECT id FROM bg_seasons WHERE id = ?"
      )
        .bind(id)
        .first();

      if (!existing) {
        return json({
          error: "Temporada não encontrada."
        }, 404);
      }

      await env.DB.prepare(`
        UPDATE bg_seasons
        SET
          name = ?,
          player_1 = ?,
          points_1 = ?,
          player_2 = ?,
          points_2 = ?,
          player_3 = ?,
          points_3 = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
        .bind(
          data.name,
          p[0].name,
          p[0].points,
          p[1].name,
          p[1].points,
          p[2].name,
          p[2].points,
          id
        )
        .run();

      return json({
        ok: true,
        id
      });
    }

    return json({
      error: "Método não permitido."
    }, 405);

  } catch (error) {
    console.error("BG seasons API:", error);

    if (
      String(error.message || "")
        .includes("UNIQUE constraint failed")
    ) {
      return json({
        error: "Já existe uma temporada com esse nome."
      }, 409);
    }

    return json({
      error: "Erro ao consultar ou guardar as temporadas."
    }, 500);
  }
}

/* ROTAS CLOUDFLARE PAGES FUNCTIONS */

export async function onRequestGet(context) {
  return handle(context);
}

export async function onRequestPost(context) {
  return handle(context);
}

export async function onRequestPut(context) {
  return handle(context);
}

export async function onRequestDelete(context) {
  return handle(context);
}
