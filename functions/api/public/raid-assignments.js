
const MAPS = ["normal", "nightmare"];
const PATHS = ["A", "B", "C"];
const ROLES = ["assalto", "vanguarda", "tatico"];

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

// API pública: apenas leitura
export async function onRequestGet({ env }) {
  if (!env.DB) {
    return json({
      ok: false,
      error: "Base de dados D1 indisponível."
    }, 503);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT
        a.group_no,
        a.map_type,
        a.path,
        a.role,
        a.member_id,
        m.name AS member_name
      FROM raid_assignments a
      LEFT JOIN alliance_members m
        ON m.id = a.member_id
      ORDER BY
        a.group_no,
        a.map_type,
        a.path,
        CASE a.role
          WHEN 'assalto' THEN 1
          WHEN 'vanguarda' THEN 2
          WHEN 'tatico' THEN 3
          ELSE 4
        END
    `).all();

    return json({
      ok: true,
      maps: MAPS,
      paths: PATHS,
      roles: ROLES,
      items: result.results || []
    });

  } catch (error) {
    console.error("RAID pública:", error);

    return json({
      ok: false,
      error: "Erro ao consultar as atribuições RAID."
    }, 500);
  }
}
