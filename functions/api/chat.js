
const MAX_NAME = 30;
const MAX_MESSAGE = 500;
const MAX_BODY = 4096;
const EMOJIS = ["👍", "❤️", "😂", "🔥"];

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
  const origin = request.headers.get("Origin");
  return origin === new URL(request.url).origin;
}

async function readBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);

  if (length > MAX_BODY) {
    throw new Error("Pedido demasiado grande");
  }

  const text = await request.text();

  if (text.length > MAX_BODY) {
    throw new Error("Pedido demasiado grande");
  }

  return JSON.parse(text);
}

function getVisitorIP(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    "unknown"
  );
}

async function hashVisitor(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getVisitorId(request) {
  return hashVisitor(getVisitorIP(request));
}

async function checkRateLimit(db, visitorId) {
  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = 10;
  const maxMessages = 3;

  const result = await db.prepare(`
    INSERT INTO chat_rate_limits (
      visitor_id,
      window_start,
      message_count
    )
    VALUES (?, ?, 1)
    ON CONFLICT(visitor_id) DO UPDATE SET
      window_start = CASE
        WHEN ? - window_start >= ?
        THEN ?
        ELSE window_start
      END,
      message_count = CASE
        WHEN ? - window_start >= ?
        THEN 1
        ELSE message_count + 1
      END
    RETURNING message_count
  `).bind(
    visitorId,
    now,
    now,
    windowSeconds,
    now,
    now,
    windowSeconds
  ).first();

  return Number(result?.message_count || 0) <= maxMessages;
}

async function getMessages(db) {
  const result = await db.prepare(`
    SELECT
      id,
      player_name AS name,
      message,
      created_at,
      reply_to_id,
      is_pinned
    FROM chat_messages
    WHERE deleted_at IS NULL
    ORDER BY id DESC
    LIMIT 60
  `).all();

  const messages = (result.results || []).reverse();

  const ids = messages.map(m => Number(m.id));

  if (!ids.length) {
    return messages;
  }

  const placeholders = ids.map(() => "?").join(",");

  const reactions = await db.prepare(`
    SELECT
      message_id,
      emoji,
      COUNT(*) AS total
    FROM chat_reactions
    WHERE message_id IN (${placeholders})
    GROUP BY message_id, emoji
  `).bind(...ids).all();

  const counts = new Map();

  for (const item of reactions.results || []) {
    const id = Number(item.message_id);

    if (!counts.has(id)) {
      counts.set(id, {});
    }

    counts.get(id)[item.emoji] = Number(item.total);
  }

  return messages.map(m => ({
    ...m,
    is_pinned: Boolean(m.is_pinned),
    reactions: counts.get(Number(m.id)) || {}
  }));
}

async function sendMessage(db, body, visitorId) {
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

  let replyToId = null;

  if (
    body.reply_to_id !== undefined &&
    body.reply_to_id !== null
  ) {
    replyToId = Number(body.reply_to_id);

    if (
      !Number.isSafeInteger(replyToId) ||
      replyToId <= 0
    ) {
      return reply({
        ok: false,
        error: "Resposta inválida"
      }, 400);
    }

    const original = await db.prepare(`
      SELECT id
      FROM chat_messages
      WHERE id = ?
        AND deleted_at IS NULL
    `).bind(replyToId).first();

    if (!original) {
      return reply({
        ok: false,
        error: "Mensagem original não encontrada"
      }, 404);
    }
  }

  const allowed = await checkRateLimit(db, visitorId);

  if (!allowed) {
    return reply({
      ok: false,
      error: "Muitas mensagens. Aguarda alguns segundos."
    }, 429);
  }

  await db.prepare(`
    INSERT INTO chat_messages (
      member_id,
      player_name,
      message,
      reply_to_id
    )
    VALUES (0, ?, ?, ?)
  `).bind(name, message, replyToId).run();

  return reply({ ok: true });
}

async function toggleReaction(db, body, visitorId) {
  const messageId = Number(body.message_id);
  const emoji = body.emoji;

  if (
    !Number.isSafeInteger(messageId) ||
    messageId <= 0 ||
    !EMOJIS.includes(emoji)
  ) {
    return reply({
      ok: false,
      error: "Reação inválida"
    }, 400);
  }

  const message = await db.prepare(`
    SELECT id
    FROM chat_messages
    WHERE id = ?
      AND deleted_at IS NULL
  `).bind(messageId).first();

  if (!message) {
    return reply({
      ok: false,
      error: "Mensagem não encontrada"
    }, 404);
  }

  const existing = await db.prepare(`
    SELECT id
    FROM chat_reactions
    WHERE message_id = ?
      AND visitor_id = ?
      AND emoji = ?
  `).bind(messageId, visitorId, emoji).first();

  if (existing) {
    await db.prepare(`
      DELETE FROM chat_reactions
      WHERE message_id = ?
        AND visitor_id = ?
        AND emoji = ?
    `).bind(messageId, visitorId, emoji).run();
  } else {
    await db.prepare(`
      INSERT OR IGNORE INTO chat_reactions (
        message_id,
        visitor_id,
        emoji
      )
      VALUES (?, ?, ?)
    `).bind(messageId, visitorId, emoji).run();
  }

  return reply({ ok: true });
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
      const messages = await getMessages(db);

      return reply({
        ok: true,
        messages
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

    const visitorId = await getVisitorId(request);

    if (body?.action === "send") {
      return await sendMessage(db, body, visitorId);
    }

    if (body?.action === "react") {
      return await toggleReaction(db, body, visitorId);
    }

    return reply({
      ok: false,
      error: "Ação inválida"
    }, 400);

  } catch (error) {
    console.error("Chat IM 2.0:", error);

    return reply({
      ok: false,
      error: "Erro interno do chat"
    }, 500);
  }
}
