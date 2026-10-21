// Consultation requests from /consultation/. Stores the request, emails the owner (reply-to = the client)
// and the client (reply-to = the owner's real inbox). Collects no health information by design.
import { json, rateLimited, isEmail } from "./core.js";
import { sendEmail, sendAlert, signature } from "./notify.js";
import { BUSINESS } from "./business.js";

const HEARD = ["Instagram", "A friend or family member", "Google", "My doctor or another practitioner", "Other"];

export async function submitInquiry(request, env, cors) {
  if (!env.DB) return json({ error: "No database" }, 503, cors);
  if (!env.RESEND_API_KEY) return json({ error: "Email not configured" }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  if (String(b._gotcha || "").trim()) return json({ ok: true }, 200, cors); // honeypot: pretend success
  if (rateLimited(request.headers.get("CF-Connecting-IP") || "")) return json({ error: "Too many requests, please try again in a few minutes" }, 429, cors);

  const email = String(b.email || "").trim().toLowerCase();
  if (!isEmail(email)) return json({ error: "Valid email required" }, 400, cors);
  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) return json({ error: "Name required" }, 400, cors);
  const phone = String(b.phone || "").trim().slice(0, 40);
  const programNames = BUSINESS.programs.map((p) => p.name);
  const interest = programNames.includes(b.interest) ? b.interest : "";
  const goal = String(b.goal || "").trim().slice(0, 600);
  const heard = HEARD.includes(b.heard) ? b.heard : "";

  const ins = await env.DB.prepare(`INSERT INTO inquiries (created_at, name, email, phone, interest, goal, heard) VALUES (?,?,?,?,?,?,?)`)
    .bind(new Date().toISOString(), name, email, phone, interest, goal, heard).run();
  const id = ins.meta && ins.meta.last_row_id;

  const toOwner = `New consultation request via your website\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone || "-"}\nInterested in: ${interest || "Not sure yet"}\nHow they found you: ${heard || "-"}\n\nWhat they'd like to feel different:\n${goal || "-"}\n\nReply to this email to answer ${name.split(" ")[0]} directly with times for the consultation.`;
  const r1 = await sendEmail(env, { to: env.SUPPORT_EMAIL || BUSINESS.email, replyTo: email, subject: `Consultation request: ${name}`, text: toOwner });

  const first = name.split(" ")[0];
  const toClient = `Hi ${first},\n\nThanks for reaching out to ${BUSINESS.name}. I've got your request for a free consultation and will email you within one business day with a few times to choose from.\n\n${BUSINESS.booking_url ? "If you'd rather pick a time now, you can book here: " + BUSINESS.booking_url + "\n\n" : ""}Please don't send medical details by email. We'll go through your health history during our consultation and in a secure intake form.\n\nTalk soon,\n${signature(env)}`;
  const r2 = await sendEmail(env, { to: email, subject: "Your free consultation request", text: toClient });

  await env.DB.prepare(`UPDATE inquiries SET emailed = ? WHERE id = ?`).bind((r1.ok ? 1 : 0) + (r2.ok ? 2 : 0), id).run();
  if (!r1.ok) { console.error("email to owner failed", r1.error); await sendAlert(env, `Consultation request from ${name} saved, but the email to you failed: ${r1.error}`); }
  return json({ ok: r1.ok, emailed_client: r2.ok, error: r1.ok ? undefined : "We saved your request but couldn't send the email" }, r1.ok ? 200 : 502, cors);
}
