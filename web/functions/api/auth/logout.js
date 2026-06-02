const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });

export async function onRequestPost() {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("set-cookie", "aimark_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  headers.append("set-cookie", "aimark_user=; Path=/; Max-Age=0; Secure; SameSite=Lax");
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export async function onRequestGet() {
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", "aimark_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  headers.append("set-cookie", "aimark_user=; Path=/; Max-Age=0; Secure; SameSite=Lax");
  return new Response(null, {
    status: 302,
    headers,
  });
}
