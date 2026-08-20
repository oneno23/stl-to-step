function isAllowed(request) {
  const origin = request.headers.get("Origin");
  if (origin) {
    if (origin === "https://stltostep.app") return true;
    if (origin.startsWith("chrome-extension://")) return true;
    if (origin.startsWith("moz-extension://")) return true;
    return false;
  }
  // Some same-origin requests omit the Origin header — fall back to Referer.
  const referer = request.headers.get("Referer") || "";
  return referer.startsWith("https://stltostep.app/");
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isAllowed(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const raw = await env.COUNTER.get("conversions");
  const current = raw ? parseInt(raw, 10) : 0;
  const next = current + 1;
  await env.COUNTER.put("conversions", String(next));

  const origin = request.headers.get("Origin") || "https://stltostep.app";

  return new Response(JSON.stringify({ count: next }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
    },
  });
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get("Origin") || "https://stltostep.app";
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
