
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

export async function onRequestPost({ request, env }) {
  try {
    if (!env.BATTLE_DB || !env.BATTLE_MEDIA ||
        !env.TURNSTILE_SECRET_KEY) {
      return json({ error: "Configuração incompleta." }, 503);
    }

    const data = await request.json();
    const type = String(data.type || "").toLowerCase();
    const size = Number(data.size);
    const token = String(data.turnstileToken || "");

    const isVideo = type.startsWith("video/");
    const maxSize = isVideo ? MAX_VIDEO : MAX_IMAGE;

    if (!TYPES[type] || !Number.isSafeInteger(size) ||
        size < 1 || size > maxSize) {
      return json({ error: "Ficheiro inválido." }, 400);
    }

    if (!token || token.length > 2048) {
      return json({ error: "Verificação necessária." }, 403);
    }

    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) {
      return json({ error: "Visitante não identificado." }, 403);
    }

    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", ip);

    const verify = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );

    if (!verify.ok) {
      return json({ error: "Erro na verificação." }, 503);
    }

    const result = await verify.json();
    if (!result.success ||
        result.hostname !== "irmaosmarvel.com") {
      return json({ error: "Verificação recusada." }, 403);
    }

    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(ip)
    );

    const visitorHash = Array.from(
      new Uint8Array(hashBuffer),
      b => b.toString(16).padStart(2, "0")
    ).join("");

    const day = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Paris"
    });

    const daily = await env.BATTLE_DB.prepare(
      `SELECT publications FROM battle_daily_limits
       WHERE visitor_hash = ? AND day = ?`
    ).bind(visitorHash, day).first();

    if (daily && daily.publications >= 2) {
      return json({
        error: "Limite de 2 publicações por dia atingido."
      }, 429);
    }

    const key = "battlehub/" + crypto.randomUUID() +
                "." + TYPES[type];

    const upload = await env.BATTLE_MEDIA.createMultipartUpload(
      key,
      { httpMetadata: { contentType: type } }
    );

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + 60 * 60 * 1000
    ).toISOString();

    try {
      await env.BATTLE_DB.prepare(
        `INSERT INTO battle_upload_sessions
         (id, media_key, r2_upload_id, visitor_hash,
          media_type, expected_size, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        sessionId, key, upload.uploadId, visitorHash,
        type, size, expiresAt
      ).run();
    } catch (error) {
      await upload.abort();
      throw error;
    }

    return json({
      ok: true,
      sessionId,
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
