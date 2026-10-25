
const MAX_SIZE = 250 * 1024 * 1024;

const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "video/mp4",
  "video/quicktime",
  "video/webm"
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.BATTLE_MEDIA) {
      return json({
        error: "BATTLE_MEDIA não configurado."
      }, 503);
    }

    const data = await request.json();

    const name = String(data.name || "").trim();
    const type = String(data.type || "").toLowerCase();
    const size = Number(data.size);

    if (
      !name ||
      name.length > 200 ||
      !ALLOWED.has(type) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_SIZE
    ) {
      return json({
        error: "Ficheiro inválido ou superior a 250 MB."
      }, 400);
    }

    const extension = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/heic": "heic",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm"
    }[type];

    const key =
      "battlehub/" +
      crypto.randomUUID() +
      "." +
      extension;

    const upload =
      await env.BATTLE_MEDIA.createMultipartUpload(key, {
        httpMetadata: {
          contentType: type
        }
      });

    return json({
      ok: true,
      key,
      uploadId: upload.uploadId,
      maxSize: MAX_SIZE,
      partSize: 10 * 1024 * 1024
    });
  } catch (error) {
    return json({
      error: "Não foi possível iniciar o upload."
    }, 500);
  }
}
