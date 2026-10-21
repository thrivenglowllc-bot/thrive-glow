// Email through Resend. Every email carries a reply-to that lands in a real inbox (SUPPORT_EMAIL),
// and FROM_EMAIL must be a mailbox someone reads.
// Text messages are intentionally left out for now; sendAlert is the one place to add Twilio later.
import { BUSINESS } from "./business.js";

export async function sendEmail(env, { to, subject, text, html, replyTo }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  if (!to || (Array.isArray(to) && !to.filter(Boolean).length)) return { ok: false, error: "No email address" };
  const body = {
    from: env.FROM_EMAIL || `${BUSINESS.name} <${env.SUPPORT_EMAIL || BUSINESS.email}>`,
    to: Array.isArray(to) ? to : [to],
    subject, text,
    reply_to: replyTo || env.SUPPORT_EMAIL || BUSINESS.email,
  };
  if (html) body.html = html;
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("resend", res.status, JSON.stringify(data).slice(0, 400)); return { ok: false, error: (data && data.message) || "Resend " + res.status }; }
    return { ok: true, id: data.id };
  } catch (e) { return { ok: false, error: "exception: " + ((e && e.message) || e) }; }
}

// Short alert to the owner. Email only today (ALERT_TO, comma-separated; defaults to SUPPORT_EMAIL).
export async function sendAlert(env, text) {
  const to = String(env.ALERT_TO || env.SUPPORT_EMAIL || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) return { ok: false, skipped: true };
  const msg = String(text).slice(0, 300);
  return sendEmail(env, { to, subject: `${BUSINESS.name}: ${msg.slice(0, 70)}`, text: msg });
}

export function signature(env) {
  return [BUSINESS.owner_name || BUSINESS.name, BUSINESS.owner_name ? BUSINESS.name : "", env.SITE_URL || BUSINESS.site_url].filter(Boolean).join("\n");
}
