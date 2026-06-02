import { json } from "../../../_auth.js";
import { makePairRecord } from "../../../_agent.js";

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = await request.json(); } catch {}
  try {
    const pair = await makePairRecord(request, env, body.device_name || "");
    return json({
      status: "pending",
      device_code: pair.device_code,
      user_code: pair.user_code,
      verification_uri: pair.verification_uri,
      verification_uri_complete: pair.verification_uri_complete,
      expires_in: 600,
      interval: 3,
      message: {
        th: "ส่งลิงก์นี้ให้ลูกค้า ลูกค้ากด Approve ครั้งเดียวเพื่ออนุมัติ Agent Bridge",
        en: "Send this link to the customer. They approve the Agent Bridge with one click.",
      },
    });
  } catch (err) {
    return json({ error: "agent_pair_start_failed", detail: String(err).slice(0, 300) }, 500);
  }
}
