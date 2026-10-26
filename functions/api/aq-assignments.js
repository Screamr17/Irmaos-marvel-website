
// AQ M8 — IRMÃOS MARVEL
// API pública: apenas consulta das atribuições.
// A edição dos oficiais continua protegida na API original.

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

export async function onRequestGet({ env }) {
  if (!env.DB) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Base de dados indisponível'
      }),
      { status: 503, headers }
    );
  }

  try {
    const result = await env.DB.prepare(
      `SELECT group_no, tier, line_no, member_id
       FROM aq_assignments
       ORDER BY group_no, tier, line_no`
    ).all();

    return new Response(
      JSON.stringify({
        ok: true,
        limits: {
          1: 7,
          2: 9,
          3: 8
        },
        items: result.results || []
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('AQ pública:', error);

    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Falha ao consultar atribuições AQ'
      }),
      { status: 500, headers }
    );
  }
}
