
const MAX_VIDEO = 250 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

const TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function visitorHash(ip, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(ip)
  );

  return Array.from(new Uint8Array(bytes))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost({ request, env }) {
  try {
    if (
      !env.BATTLE_DB ||
      !env.BATTLE_MEDIA ||
      !env.TURNSTILE_SECRET_KEY ||
      !env.VISITOR_HASH_SECRET
    ) {
      return json({
        error: "Configuração de segurança incompleta."
      }, 503);
    }

    const data = await request.json();
    const name = String(data.name || "").trim();
    const type = String(data.type || "").toLowerCase();
    const size = Number(data.size);
    const token = String(data.turnstileToken || "");

    const extension = TYPES[type];
    const isVideo = type.startsWith("video/");
    const maxSize = isVideo ? MAX_VIDEO : MAX_IMAGE;

    if (
      !extension ||
      !name ||
      name.length > 200 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > maxSize
    ) {
      return json({
        error: "Tipo ou tamanho de ficheiro inválido."
      }, 400);
    }

    if (!token || token.length > 2048) {
      return json({
        error: "Verificação Turnstile obrigatória."
      }, 403);
    }

    const ip = request.headers.get("CF-Connecting-IP");

    if (!ip) {
      return json({
        error: "Não foi possível verificar o visitante."
      }, 403);
    }

    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", ip);

    const verification = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );

    if (!verification.ok) {
      return json({
        error: "Verificação indisponível."
      }, 503);
    }

    const result = await verification.json();

    if (
      !result.success ||
      result.hostname !== "irmaosmarvel.com"
    ) {
      return json({
        error: "Verificação Turnstile recusada."
      }, 403);
    }

    const visitor = await visitorHash(
      ip,
      env.VISITOR_HASH_SECRET
    );

    const day = new Date().toLocaleDateString(
      "en-CA",
      { timeZone: "Europe/Paris" }
    );

    const daily = await env.BATTLE_DB.prepare(
      `SELECT publications
       FROM battle_daily_limits
       WHERE visitor_hash = ? AND day = ?`
    ).bind(visitor, day).first();

    if ((daily?.publications || 0) >= 2) {
      return json({
        error: "Limite diário de publicações atingido."
      }, 429);
    }

    const pending = await env.BATTLE_DB.prepare(
      `SELECT COUNT(*) AS total
       FROM battle_upload_sessions
       WHERE visitor_hash = ?
       AND status = 'started'
       AND expires_at > CURRENT_TIMESTAMP`
    ).bind(visitor).first();

    if ((pending?.total || 0) >= 2) {
      return json({
        error: "Já tens dois uploads em preparação."
      }, 429);
    }

    const id = crypto.randomUUID();
    const key = "battlehub/" + id + "." + extension;

    const upload = await env.BATTLE_MEDIA.createMultipartUpload(
      key,
      {
        httpMetadata: { contentType: type }
      }
    );

    const expires = new Date(
      Date.now() + 60 * 60 * 1000
    ).toISOString().replace("T", " ").slice(0, 19);

    try {
      await env.BATTLE_DB.prepare(
        `INSERT INTO battle_upload_sessions
        (id, media_key, r2_upload_id, visitor_hash,
         media_type, expected_size, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, key, upload.uploadId, visitor,
        type, size, expires
      ).run();
    } catch (error) {
      await upload.abort();
      throw error;
    }

    return json({
      ok: true,
      sessionId: id,
      key,
      uploadId: upload.uploadId,
      partSize: 10 * 1024 * 1024
    });
  } catch (error) {
    return json({
      error: "Não foi possível iniciar o upload."
    }, 500);
  }
}
