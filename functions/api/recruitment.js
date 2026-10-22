
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

const validStatuses = ["pending", "approved", "rejected"];

function getOfficerEmails(env) {
  return String(env.OFFICER_EMAILS || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function base64urlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}

async function authenticate(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const teamDomain = String(env.ACCESS_TEAM_DOMAIN || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const audience = String(env.ACCESS_AUD || "");
  if (!teamDomain || !audience) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const header = JSON.parse(base64urlDecode(parts[0]));
  const payload = JSON.parse(base64urlDecode(parts[1]));

  if (header.alg !== "RS256") return null;

  const keysResponse = await fetch(
    `https://${teamDomain}/cdn-cgi/access/certs`
  );

  if (!keysResponse.ok) return null;

  const keys = await keysResponse.json();
  const jwk = keys.keys?.find(key => key.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signature = Uint8Array.from(
    base64urlDecode(parts[2]),
    character => character.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );

  const now = Math.floor(Date.now() / 1000);

  if (
    !valid ||
    payload.iss !== `https://${teamDomain}` ||
    !(Array.isArray(payload.aud)
      ? payload.aud.includes(audience)
      : payload.aud === audience) ||
    typeof payload.exp !== "number" ||
    payload.exp <= now ||
    (typeof payload.nbf === "number" && payload.nbf > now)
  ) {
    return null;
  }

  const email = String(payload.email || "").toLowerCase();
  if (!getOfficerEmails(env).includes(email)) return null;

  return email;
}

async function handler(context) {
  const { request, env } = context;

  if (!env.DB) {
    return json({ error: "Base de dados indisponível." }, 503);
  }

  let email;

  try {
    email = await authenticate(request, env);
  } catch (error) {
    console.error("Access authentication:", error);
    return json({ error: "Falha de autenticação." }, 401);
  }

  if (!email) {
    return json({ error: "Acesso reservado aos oficiais." }, 403);
  }

  try {
    if (request.method === "GET") {
      const settings = await env.DB.prepare(
        "SELECT is_open FROM recruitment_settings WHERE id = 1"
      ).first();

      const result = await env.DB.prepare(`
        SELECT id, name, prestige, aw, bg_points,
               discord, preferred_group, message,
               status, created_at, updated_at
        FROM recruitment_applications
        ORDER BY created_at DESC, id DESC
        LIMIT 200
      `).all();

      return json({
        ok: true,
        email,
        open: settings?.is_open === 1,
        items: result.results || []
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Método não permitido." }, 405);
    }

    const raw = await request.text();

    if (raw.length > 10000) {
      return json({ error: "Pedido demasiado grande." }, 413);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: "JSON inválido." }, 400);
    }

    if (data.action === "set_status") {
      if (typeof data.open !== "boolean") {
        return json({ error: "Estado inválido." }, 400);
      }

      await env.DB.prepare(`
        UPDATE recruitment_settings
        SET is_open = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).bind(data.open ? 1 : 0).run();

      return json({ ok: true, open: data.open });
    }

    if (data.action === "review") {
      const id = Number(data.id);
      const status = String(data.status || "");

      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !validStatuses.includes(status)
      ) {
        return json({ error: "Dados inválidos." }, 400);
      }

      const result = await env.DB.prepare(`
        UPDATE recruitment_applications
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(status, id).run();

      if (!result.meta?.changes) {
        return json({ error: "Candidatura não encontrada." }, 404);
      }

      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);

  } catch (error) {
    console.error("Recruitment API:", error);
    return json({ error: "Erro interno do servidor." }, 500);
  }
}

export const onRequestGet = handler;
export const onRequestPost = handler;
