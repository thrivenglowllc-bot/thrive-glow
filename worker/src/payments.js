// Program checkout through Stripe Checkout, the Stripe webhook, and paid confirmations.
// Test mode vs live mode is decided by the key: sk_test_... or sk_live_...
import { json, hmacHex, timingSafeEqual, newRef, dollars } from "./core.js";
import { sendEmail, sendAlert, signature } from "./notify.js";
import { BUSINESS } from "./business.js";

// Stripe's API takes form encoding with bracketed keys: line_items[0][price_data][currency]=usd
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
}

export function stripeFetch(env, path, { method = "GET", body, idempotencyKey } = {}) {
  const headers = { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": "2024-06-20" };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return fetch("https://api.stripe.com" + path, { method, headers, body: body ? form(body).toString() : undefined });
}

export async function checkout(request, env, cors) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments are not set up yet" }, 503, cors);
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  const program = BUSINESS.programs.find((p) => p.key === b.program);
  if (!program) return json({ error: "Unknown program" }, 400, cors);

  const ref = newRef();
  const depositPct = Math.min(100, Math.max(1, parseInt(env.DEPOSIT_PERCENT || BUSINESS.deposit_percent || 100, 10) || 100));
  const amount = Math.round(program.price_cents * depositPct / 100);
  const itemName = depositPct === 100 ? program.name : `${depositPct}% deposit: ${program.name} (${dollars(program.price_cents)} total)`;
  const site = env.SITE_URL || BUSINESS.site_url;
  const res = await stripeFetch(env, "/v1/checkout/sessions", { method: "POST", idempotencyKey: ref, body: {
    mode: "payment",
    client_reference_id: ref,
    success_url: `${site}/thanks/?paid=1&ref=${ref}`,
    cancel_url: `${site}/#programs`,
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amount, product_data: { name: itemName, description: program.length } } }],
    payment_intent_data: { description: `${BUSINESS.name} ${ref}: ${program.name}`, metadata: { ref } },
    metadata: { ref, program: program.key },
  } });
  const data = await res.json().catch(() => ({}));
  const ok = res.ok && data.url;
  if (!ok) console.error("Stripe error", res.status, JSON.stringify(data).slice(0, 800));
  await env.DB.prepare(`INSERT INTO orders (ref, created_at, status, program_key, program_name, amount_cents, session_id) VALUES (?,?,?,?,?,?,?)`)
    .bind(ref, new Date().toISOString(), ok ? "checkout_started" : "failed", program.key, program.name, amount, ok ? data.id : null).run();
  if (!ok) return json({ error: (data.error && data.error.message) || "Stripe did not return a checkout page" }, 502, cors);
  return json({ url: data.url, ref }, 200, cors);
}

// The thanks page polls this. If the webhook hasn't landed yet, ask Stripe directly so the client isn't left waiting.
export async function orderStatus(env, ref, cors) {
  const headers = { ...cors, "Cache-Control": "no-store" };
  if (!ref || !/^TG-[A-Z0-9]{6}$/.test(ref)) return json({ error: "Bad reference" }, 400, headers);
  let o = await env.DB.prepare(`SELECT status, program_name, session_id FROM orders WHERE ref = ?`).bind(ref).first();
  if (!o) return json({ error: "Not found" }, 404, headers);
  if (o.status === "checkout_started" && o.session_id && env.STRIPE_SECRET_KEY) {
    await pullSession(env, o.session_id).catch((e) => console.error("pull", e));
    o = await env.DB.prepare(`SELECT status, program_name FROM orders WHERE ref = ?`).bind(ref).first();
  }
  return json({ status: o.status === "paid" ? "paid" : "pending", program: o.program_name }, 200, headers);
}

// Hourly safety net: catch any payment whose webhook never arrived.
export async function sweepUnpaid(env) {
  if (!env.DB || !env.STRIPE_SECRET_KEY) return { checked: 0 };
  const since = new Date(Date.now() - 3 * 864e5).toISOString();
  const rows = (await env.DB.prepare(`SELECT session_id FROM orders WHERE status = 'checkout_started' AND session_id IS NOT NULL AND created_at > ? LIMIT 50`).bind(since).all()).results;
  for (const r of rows) await pullSession(env, r.session_id).catch((e) => console.error("sweep", e));
  return { checked: rows.length };
}

async function pullSession(env, sessionId) {
  const s = await (await stripeFetch(env, `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`)).json().catch(() => ({}));
  if (s && s.payment_status === "paid") await markPaid(env, s);
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.payload">. Reject anything older than 5 minutes.
export async function verifyStripe(env, raw, header, now = Date.now()) {
  const parts = Object.fromEntries(String(header || "").split(",").map((p) => p.split("=").map((s) => s.trim())).filter((p) => p.length === 2 && p[0] !== "v1"));
  const sigs = String(header || "").split(",").map((p) => p.trim()).filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = parseInt(parts.t, 10);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${t}.${raw}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

export async function stripeWebhook(request, env) {
  const raw = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Webhook secret not configured" }, 503);
  if (!await verifyStripe(env, raw, request.headers.get("Stripe-Signature"))) { console.error("Stripe signature mismatch"); return json({ error: "Bad signature" }, 400); }
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: "Bad JSON" }, 400); }
  const obj = (evt.data && evt.data.object) || {};
  if ((evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") && obj.payment_status === "paid") await markPaid(env, obj);
  if (evt.type === "charge.refunded") await markRefund(env, obj);
  return json({ received: true });
}

async function markPaid(env, s) {
  const ref = s.client_reference_id || (s.metadata && s.metadata.ref);
  if (!ref) return;
  const c = s.customer_details || {};
  const res = await env.DB.prepare(`UPDATE orders SET status = 'paid', payment_intent = ?, paid_at = COALESCE(paid_at, ?), paid_cents = ?, email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE ref = ? AND status IN ('checkout_started','failed','paid')`)
    .bind(s.payment_intent || null, new Date((s.created || Date.now() / 1000) * 1000).toISOString(), s.amount_total || 0, c.email || null, c.name || null, ref).run();
  if (!res.meta || !res.meta.changes) return;
  if (s.payment_intent) await recordFee(env, ref, s.payment_intent).catch((e) => console.error("fee", e));
  await notifyPaid(env, ref);
}

// Card fee, so the owner page shows what actually lands in the bank.
async function recordFee(env, ref, paymentIntent) {
  const pi = await (await stripeFetch(env, `/v1/payment_intents/${encodeURIComponent(paymentIntent)}?expand[]=latest_charge.balance_transaction`)).json().catch(() => ({}));
  const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
  if (bt && typeof bt.fee === "number") await env.DB.prepare(`UPDATE orders SET fee_cents = ? WHERE ref = ?`).bind(bt.fee, ref).run();
}

async function markRefund(env, charge) {
  if (!charge.payment_intent) return;
  const refunded = charge.amount_refunded || 0;
  await env.DB.prepare(`UPDATE orders SET refunded_cents = ?, status = CASE WHEN ? >= paid_cents AND paid_cents > 0 THEN 'refunded' ELSE status END WHERE payment_intent = ?`)
    .bind(refunded, refunded, charge.payment_intent).run();
}

// Sends the client and owner emails exactly once per order (guarded by notified_paid_at).
export async function notifyPaid(env, ref) {
  const claim = await env.DB.prepare(`UPDATE orders SET notified_paid_at = ? WHERE ref = ? AND status = 'paid' AND notified_paid_at IS NULL`).bind(new Date().toISOString(), ref).run();
  if (!claim.meta || !claim.meta.changes) return;
  const o = await env.DB.prepare(`SELECT * FROM orders WHERE ref = ?`).bind(ref).first();
  const paid = dollars(o.paid_cents);
  const first = (o.name || "").split(" ")[0] || "there";
  if (o.email) await sendEmail(env, { to: o.email, subject: `You're in: ${o.program_name}`, text:
`Hi ${first},

Payment received, ${paid}, for ${o.program_name}. Thank you for trusting me with this.

What happens next:
1. Within one business day I'll email you a link to your secure intake form and a few times for your first session.
2. Fill in the intake form before we meet, so our first session goes straight to the useful part.
3. At our first session we'll map out where to start.

Your reference is ${ref}. Questions? Just reply to this email.

${signature(env)}` });
  await sendAlert(env, `PAID ${paid}: ${o.program_name} by ${o.name || o.email || "a client"} (${ref}). Send intake form and first-session times.`);
}
