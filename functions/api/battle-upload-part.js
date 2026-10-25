
const PART_SIZE = 10 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPut({ request, env }) {
  try {
    if (!env.BATTLE_MEDIA) {
      return json({
        error: "Armazenamento R2 não configurado."
      }, 503);
    }

    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = Number(
      url.searchParams.get("partNumber")
    );

    if (
      !key ||
      !/^battlehub\/[a-f0-9-]{36}\.[a-z0-9]+$/.test(key) ||
      !uploadId ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > 25
    ) {
      return json({
        error: "Dados do upload inválidos."
      }, 400);
    }

    const length = Number(
      request.headers.get("Content-Length")
    );

    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > PART_SIZE
    ) {
      return json({
        error: "Parte inválida. Máximo de 10 MB."
      }, 413);
    }

    const upload =
      env.BATTLE_MEDIA.resumeMultipartUpload(
        key,
        uploadId
      );

    const part = await upload.uploadPart(
      partNumber,
      request.body
    );

    return json({
      ok: true,
      partNumber: part.partNumber,
      etag: part.etag
    });
  } catch (error) {
    return json({
      error: "Não foi possível enviar esta parte."
    }, 500);
  }
}
