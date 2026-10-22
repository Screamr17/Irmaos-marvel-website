
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

async function getSettings(env) {
  if (!env.DB) {
    throw new Error("D1 não configurada");
  }

  const row = await env.DB.prepare(
    "SELECT is_open FROM recruitment_settings WHERE id = 1"
  ).first();

  return row?.is_open === 1;
}

export async function onRequestGet({ env }) {
  try {
    const open = await getSettings(env);
    return json({ open });
  } catch (error) {
    console.error("Recruitment GET:", error);
    return json({ error: "Serviço indisponível" }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const open = await getSettings(env);

    if (!open) {
      return json({
        error: "O recrutamento está encerrado."
      }, 403);
    }

    const contentType =
      request.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      return json({ error: "Formato inválido." }, 415);
    }

    const length = Number(
      request.headers.get("content-length") || 0
    );

    if (length > 10000) {
      return json({ error: "Pedido demasiado grande." }, 413);
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

    const name = String(data.name || "").trim();
    const discord = String(data.discord || "").trim();
    const aw = String(data.aw || "").trim();
    const preferredGroup =
      String(data.preferred_group || "").trim();
    const message = String(data.message || "").trim();

    const prestige = Number(data.prestige);
    const bgPoints = Number(data.bg_points);

    const allowedAW = [
      "Platina 1", "Platina 2", "Platina 3",
      "Platina 4", "Platina 5", "Platina 6",
      "Ouro", "Outro"
    ];

    if (
      name.length < 2 ||
      name.length > 100 ||
      discord.length < 2 ||
      discord.length > 100 ||
      !allowedAW.includes(aw) ||
      !Number.isSafeInteger(prestige) ||
      prestige < 0 ||
      prestige > 9999999 ||
      !Number.isSafeInteger(bgPoints) ||
      bgPoints < 0 ||
      bgPoints > 999999999 ||
      !["", "G1", "G2", "G3"].includes(preferredGroup) ||
      message.length > 1500
    ) {
      return json({
        error: "Verifica os dados da candidatura."
      }, 400);
    }

    // Evita candidaturas duplicadas recentes
    // com o mesmo nome e Discord.
    const duplicate = await env.DB.prepare(`
      SELECT id
      FROM recruitment_applications
      WHERE lower(name) = lower(?)
        AND lower(discord) = lower(?)
        AND created_at >= datetime('now', '-24 hours')
      LIMIT 1
    `).bind(name, discord).first();

    if (duplicate) {
      return json({
        error: "Já enviaste uma candidatura nas últimas 24 horas."
      }, 429);
    }

    await env.DB.prepare(`
      INSERT INTO recruitment_applications
      (name, prestige, aw, bg_points, discord,
       preferred_group, message, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).bind(
      name, prestige, aw, bgPoints,
      discord, preferredGroup, message
    ).run();

    return json({
      ok: true,
      message: "Candidatura recebida."
    }, 201);

  } catch (error) {
    console.error("Recruitment POST:", error);
    return json({
      error: "Não foi possível processar a candidatura."
    }, 503);
  }
}
