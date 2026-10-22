
const COOKIE = "im_chat_session";
const SESSION_DAYS = 30;
const MAX_MESSAGE = 500;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

async function hash(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

function cookies(request) {
  const result = {};
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    result[part.slice(0, index).trim()] =
      part.slice(index + 1).trim();
  }
  return result;
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/api/chat; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

async function getMember(request, db) {
  const session = cookies(request)[COOKIE];
  if (!session || !/^[a-f0-9]{64}$/.test(session)) {
    return null;
  }

  return db.prepare(`
    SELECT id, player_name
    FROM chat_accounts
    WHERE session_token_hash = ?
      AND is_active = 1
      AND session_expires_at > ?
  `).bind(
    await hash(session),
    new Date().toISOString()
  ).first();
}

async function readBody(request) {
  const length = Number(
    request.headers.get("Content-Length") || 0
  );
  if (length > 4096) throw Error("Pedido demasiado grande");

  const text = await request.text();
  if (text.length > 4096) {
    throw Error("Pedido demasiado grande");
  }
  return JSON.parse(text);
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  if (!db) {
    return json({
      ok: false,
      error: "Base de dados não configurada"
    }, 503);
  }

  try {
    if (request.method === "GET") {
      const member = await getMember(request, db);

      if (!member) {
        return json({
          ok: true,
          authenticated: false,
          messages: []
        });
      }

      const result = await db.prepare(`
        SELECT
          m.id,
          a.player_name AS name,
          m.message,
          m.created_at
        FROM chat_messages m
        JOIN chat_accounts a ON a.id = m.member_id
        WHERE m.deleted_at IS NULL
        ORDER BY m.id DESC
        LIMIT 60
      `).all();

      return json({
        ok: true,
        authenticated: true,
        member: {
          id: member.id,
          name: member.player_name
        },
        messages: (result.results || []).reverse()
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Método inválido" }, 405);
    }

    if (!sameOrigin(request)) {
      return json({
        ok: false,
        error: "Origem não autorizada"
      }, 403);
    }

    let body;
    try {
      body = await readBody(request);
    } catch {
      return json({
        ok: false,
        error: "Dados inválidos"
      }, 400);
    }

    if (!body || typeof body !== "object") {
      return json({ ok: false, error: "Dados inválidos" }, 400);
    }

    if (body.action === "login") {
      const name = String(body.name || "").trim();
      const code = String(body.code || "").trim();

      if (!name || !code || name.length > 60 ||
          code.length > 128) {
        return json({
          ok: false,
          error: "Nome ou código inválido"
        }, 400);
      }

      const account = await db.prepare(`
        SELECT id, player_name
        FROM chat_accounts
        WHERE player_name = ?
          AND invite_code_hash = ?
          AND is_active = 1
      `).bind(name, await hash(code)).first();

      if (!account) {
        return json({
          ok: false,
          error: "Nome ou código incorreto"
        }, 401);
      }

      const session = token();
      const expiry = new Date(
        Date.now() + SESSION_DAYS * 86400000
      ).toISOString();

      await db.prepare(`
        UPDATE chat_accounts
        SET session_token_hash = ?,
            session_expires_at = ?
        WHERE id = ?
      `).bind(
        await hash(session),
        expiry,
        account.id
      ).run();

      return json({
        ok: true,
        authenticated: true,
        name: account.player_name
      }, 200, {
        "Set-Cookie": sessionCookie(
          session,
          SESSION_DAYS * 86400
        )
      });
    }

    const member = await getMember(request, db);

    if (!member) {
      return json({
        ok: false,
        error: "Precisas de entrar no chat"
      }, 401);
    }

    if (body.action === "logout") {
      await db.prepare(`
        UPDATE chat_accounts
        SET session_token_hash = NULL,
            session_expires_at = NULL
        WHERE id = ?
      `).bind(member.id).run();

      return json({ ok: true }, 200, {
        "Set-Cookie": sessionCookie("", 0)
      });
    }

    if (body.action === "send") {
      if (typeof body.message !== "string") {
        return json({
          ok: false,
          error: "Mensagem inválida"
        }, 400);
      }

      const message = body.message.trim();

      if (!message || message.length > MAX_MESSAGE) {
        return json({
          ok: false,
          error: "A mensagem deve ter entre 1 e 500 caracteres"
        }, 400);
      }

      const recent = await db.prepare(`
        SELECT COUNT(*) AS total
        FROM chat_messages
        WHERE member_id = ?
          AND created_at >= datetime('now', '-10 seconds')
      `).bind(member.id).first();

      if (Number(recent?.total || 0) >= 3) {
        return json({
          ok: false,
          error: "Aguarda alguns segundos antes de enviar"
        }, 429);
      }

      await db.prepare(`
        INSERT INTO chat_messages (member_id, message)
        VALUES (?, ?)
      `).bind(member.id, message).run();

      return json({ ok: true });
    }

    return json({
      ok: false,
      error: "Ação desconhecida"
    }, 400);

  } catch (error) {
    console.error("Chat API:", error);
    return json({
      ok: false,
      error: "Erro interno do chat"
    }, 500);
  }
}
