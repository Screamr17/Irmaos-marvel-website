
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

function validOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}

async function readBody(request) {
  const text = await request.text();

  if (text.length > MAX_BODY) {
    throw new Error("Pedido demasiado grande");
  }

  return JSON.parse(text);
}

export async function onRequest(context) {
  const { request, env } = context;
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
          m.id,
          COALESCE(a.player_name, 'Jogador') AS name,
          m.message,
          m.created_at
        FROM chat_messages m
        LEFT JOIN chat_accounts a
          ON a.id = m.member_id
        WHERE m.deleted_at IS NULL
        ORDER BY m.id DESC
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

    if (!validOrigin(request)) {
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

    const name = String(body.name || "").trim();
    const message = String(body.message || "").trim();

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
      Esta versão é pública.
      Vamos guardar o nome diretamente na mensagem.
      Não depende de uma conta de jogador.
    */

    await db.prepare(`
      INSERT INTO chat_messages (
        member_id,
        message
      )
      VALUES (
        0,
        ?
      )
    `).bind(
      JSON.stringify({
        name,
        text: message
      })
    ).run();

    return reply({ ok: true });

  } catch (error) {
    console.error("Chat IM:", error);

    return reply({
      ok: false,
      error: "Erro interno do chat"
    }, 500);
  }
}
