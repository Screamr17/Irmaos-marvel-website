
const MAX_NAME = 30;
const MAX_MESSAGE = 500;
const MAX_BODY = 4096;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function sameOrigin(request) {
  return request.headers.get("Origin") ===
    new URL(request.url).origin;
}

async function readBody(request) {
  const length = Number(
    request.headers.get("Content-Length") || 0
  );

  if (length > MAX_BODY) {
    throw Error("Pedido demasiado grande");
  }

  const text = await request.text();

  if (text.length > MAX_BODY) {
    throw Error("Pedido demasiado grande");
  }

  return JSON.parse(text);
}

export async function onRequest({ request, env }) {
  const db = env.DB;

  if (!db) {
    return reply({
      ok: false,
      error: "Base de dados indisponível"
    }, 503);
  }

  try {
    if (request.method === "GET") {
      const result = await db.prepare(`
        SELECT
          id,
          player_name AS name,
          message,
          created_at
        FROM chat_messages
        WHERE deleted_at IS NULL
        ORDER BY id DESC
        LIMIT 60
      `).all();

      return reply({
        ok: true,
        messages: (result.results || []).reverse()
      });
    }

    if (request.method !== "POST") {
      return reply({
        ok: false,
        error: "Método não permitido"
      }, 405);
    }

    if (!sameOrigin(request)) {
      return reply({
        ok: false,
        error: "Origem não autorizada"
      }, 403);
    }

    let body;

    try {
      body = await readBody(request);
    } catch {
      return reply({
        ok: false,
        error: "Dados inválidos"
      }, 400);
    }

    if (body?.action !== "send") {
      return reply({
        ok: false,
        error: "Ação inválida"
      }, 400);
    }

    if (
      typeof body.name !== "string" ||
      typeof body.message !== "string"
    ) {
      return reply({
        ok: false,
        error: "Nome ou mensagem inválidos"
      }, 400);
    }

    const name = body.name.trim();
    const message = body.message.trim();

    if (
      !name ||
      name.length > MAX_NAME ||
      !message ||
      message.length > MAX_MESSAGE
    ) {
      return reply({
        ok: false,
        error: "Nome ou mensagem inválidos"
      }, 400);
    }

    /*
      Limite global simples:
      no máximo 3 mensagens em 10 segundos.

      Este limite protege contra rajadas,
      mas não substitui rate limiting por IP
      ou Cloudflare Turnstile.
    */
    const recent = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM chat_messages
      WHERE created_at >= datetime('now', '-10 seconds')
    `).first();

    if (Number(recent?.total || 0) >= 3) {
      return reply({
        ok: false,
        error: "Muitas mensagens. Aguarda alguns segundos."
      }, 429);
    }

    await db.prepare(`
      INSERT INTO chat_messages (
        member_id,
        player_name,
        message
      )
      VALUES (0, ?, ?)
    `).bind(name, message).run();

    return reply({ ok: true });

  } catch (error) {
    console.error("Chat IM:", error);

    return reply({
      ok: false,
      error: "Erro interno do chat"
    }, 500);
  }
}
