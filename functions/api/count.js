export async function onRequestGet(context) {
  const { env } = context;
  const raw = await env.COUNTER.get("conversions");
  const count = raw ? parseInt(raw, 10) : 0;

  return new Response(JSON.stringify({ count }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
