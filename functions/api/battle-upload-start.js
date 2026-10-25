
const MAX_VIDEO = 250 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;

const ALLOWED = {
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
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
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

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(ip)
  );

  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost({ request, env }) {
  if (
    !env.BATTLE_DB ||
    !env.BATTLE_MEDIA ||
    !env.TURNSTILE_SECRET_KEY
  ) {
    return json({
      error: "Configuração Cloudflare incompleta."
    }, 503);
  }

  try {
    const ip = request.headers.get("CF-Connecting-IP");

    if (!ip) {
      return json({ error: "Visitante inválido." }, 403);
    }

    const data = await request.json();

    const name = String(data.name || "").trim();
    const type = String(data.type || "").toLowerCase();
    const size = Number(data.size);
    const token = String(data.turnstileToken || "");

    const extension = ALLOWED[type];
    const maxSize = type.startsWith("image/")
      ? MAX_IMAGE
      : MAX_VIDEO;

    if (
      !name ||
      name.length > 200 ||
      !Object.prototype.hasOwnProperty.call(ALLOWED, type) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > maxSize
    ) {
      return json({
        error: "Formato ou tamanho inválido."
      }, 400);
    }

    if (!token || token.length > 4096) {
      return json({
        error: "Verificação Turnstile obrigatória."
      }, 403);
    }

    const form = new FormData();
    form.set("secret", env.TURNSTILE_SECRET_KEY);
    form.set("response", token);
    form.set("remoteip", ip);

    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );

    if (!response.ok) {
      return json({
        error: "Erro na verificação de segurança."
      }, 503);
    }

    const verified = await response.json();

    if (
      !verified.success ||
      verified.hostname !== "irmaosmarvel.com"
    ) {
      return json({
        error: "Verificação de segurança recusada."
      }, 403);
    }

    const visitor = await visitorHash(
      ip,
      env.TURNSTILE_SECRET_KEY
    );

    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());

    const daily = await env.BATTLE_DB.prepare(
      `SELECT publications
       FROM battle_daily_limits
       WHERE visitor_hash = ? AND day = ?`
    ).bind(visitor, day).first();

    const active = await env.BATTLE_DB.prepare(
      `SELECT COUNT(*) AS total
       FROM battle_upload_sessions
       WHERE visitor_hash = ?
       AND status IN ('started', 'completed')
       AND expires_at > CURRENT_TIMESTAMP`
    ).bind(visitor).first();

    const count =
      Number(daily?.publications || 0) +
      Number(active?.total || 0);

    if (count >= 2) {
      return json({
        error: "Limite de 2 publicações diárias atingido."
      }, 429);
    }

    const key =
      "battlehub/" +
      crypto.randomUUID() +
      "." +
      extension;

    const sessionId = crypto.randomUUID();

    const expiresAt = new Date(
      Date.now() + 60 * 60 * 1000
    ).toISOString().replace("T", " ").slice(0, 19);

    const upload =
      await env.BATTLE_MEDIA.createMultipartUpload(key, {
        httpMetadata: { contentType: type }
      });

    try {
      await env.BATTLE_DB.prepare(
        `INSERT INTO battle_upload_sessions
         (id, media_key, r2_upload_id,
          visitor_hash, media_type, expected_size,
          status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        sessionId,
        key,
        upload.uploadId,
        visitor,
        type,
        size,
        "started",
        expiresAt
      ).run();
    } catch (error) {
      await upload.abort().catch(() => {});
      throw error;
    }

    return json({
      ok: true,
      sessionId,
      key,
      uploadId: upload.uploadId,
      maxSize,
      partSize: PART_SIZE
    });

  } catch (error) {
    return json({
      error: "Não foi possível iniciar o upload."
    }, 500);
  }
}
