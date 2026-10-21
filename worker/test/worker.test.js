import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, mockFetch, call, signedWebhook, emails, ORIGIN } from "./helpers.js";
import { BUSINESS } from "../src/business.js";

const PROGRAM = BUSINESS.programs[0];

test("health answers", async () => {
  mockFetch();
  const r = await call(makeEnv(), "/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("CORS: unknown origins are refused on public posts", async () => {
  mockFetch();
  const r = await call(makeEnv(), "/submit", { method: "POST", body: { name: "A", email: "a@b.co" }, origin: "https://evil.test" });
  assert.equal(r.status, 403);
});

test("CORS: preflight from the site gets the allow header", async () => {
  mockFetch();
  const r = await call(makeEnv(), "/submit", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("discovery request: stored, owner emailed with reply-to client, client emailed with reply-to owner", async () => {
  const calls = mockFetch();
  const env = makeEnv();
  const r = await call(env, "/submit", { method: "POST", body: { name: "Maya Lopez", email: "Maya@Example.com", phone: "8585551234", interest: PROGRAM.name, goal: "Less bloating", heard: "Instagram" } });
  assert.equal(r.status, 200, r.text);
  const row = env.DB.raw.prepare("SELECT * FROM inquiries").get();
  assert.equal(row.email, "maya@example.com");
  assert.equal(row.interest, PROGRAM.name);
  assert.equal(row.emailed, 3);
  const [toOwner, toClient] = emails(calls);
  assert.deepEqual(toOwner.to, ["owner@thrive.test"]);
  assert.equal(toOwner.reply_to, "maya@example.com");
  assert.match(toOwner.text, /Less bloating/);
  assert.deepEqual(toClient.to, ["maya@example.com"]);
  assert.equal(toClient.reply_to, "owner@thrive.test");
  assert.match(toClient.text, /Hi Maya/);
});

test("discovery request: unknown dropdown values are dropped, not stored", async () => {
  mockFetch();
  const env = makeEnv();
  await call(env, "/submit", { method: "POST", body: { name: "A", email: "a@b.co", interest: "<script>", heard: "spam" } });
  const row = env.DB.raw.prepare("SELECT interest, heard FROM inquiries").get();
  assert.equal(row.interest, "");
  assert.equal(row.heard, "");
});

test("discovery request: bad email and missing name are rejected", async () => {
  mockFetch();
  const env = makeEnv();
  assert.equal((await call(env, "/submit", { method: "POST", body: { name: "A", email: "nope" } })).status, 400);
  assert.equal((await call(env, "/submit", { method: "POST", body: { name: "", email: "a@b.co" } })).status, 400);
});

test("discovery request: honeypot pretends success and stores nothing", async () => {
  const calls = mockFetch();
  const env = makeEnv();
  const r = await call(env, "/submit", { method: "POST", body: { name: "Bot", email: "b@b.co", _gotcha: "x" } });
  assert.equal(r.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM inquiries").get().n, 0);
  assert.equal(emails(calls).length, 0);
});

test("discovery request: rate limit kicks in", async () => {
  mockFetch();
  const env = makeEnv();
  let last;
  for (let i = 0; i < 10; i++) last = await call(env, "/submit", { method: "POST", body: { name: "A", email: "a@b.co" }, headers: { "CF-Connecting-IP": "1.2.3.4" } });
  assert.equal(last.status, 429);
});

const AMOUNT = (b, i = 0) => Number(b[`line_items[${i}][price_data][unit_amount]`]);
const stripeSession = (id = "cs_test_1") => ["/v1/checkout/sessions", (url, body) => (url.endsWith("/v1/checkout/sessions") ? { body: { id, url: "https://checkout.stripe.com/c/pay/" + id } } : { body: {} })];

test("checkout: creates a Stripe Checkout page at the program price and records the order", async () => {
  const calls = mockFetch([stripeSession()]);
  const env = makeEnv();
  const r = await call(env, "/checkout", { method: "POST", body: { program: PROGRAM.key } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.match(r.json.ref, /^TG-[A-Z0-9]{6}$/);
  const sent = calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body;
  assert.equal(AMOUNT(sent), PROGRAM.price_cents);
  assert.equal(sent.client_reference_id, r.json.ref);
  assert.equal(sent.mode, "payment");
  assert.equal(sent["line_items[0][price_data][currency]"], "usd");
  assert.match(sent.success_url, new RegExp("/thanks/\\?paid=1&ref=" + r.json.ref));
  const o = env.DB.raw.prepare("SELECT * FROM orders").get();
  assert.equal(o.status, "checkout_started");
  assert.equal(o.session_id, "cs_test_1");
  assert.equal(o.amount_cents, PROGRAM.price_cents);
});

test("checkout: price comes from the server, never the browser", async () => {
  const calls = mockFetch([stripeSession()]);
  await call(makeEnv(), "/checkout", { method: "POST", body: { program: PROGRAM.key, price_cents: 1 } });
  assert.equal(AMOUNT(calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body), PROGRAM.price_cents);
});

test("checkout: deposit percent charges part of the price", async () => {
  const calls = mockFetch([stripeSession()]);
  await call(makeEnv({ DEPOSIT_PERCENT: "50" }), "/checkout", { method: "POST", body: { program: PROGRAM.key } });
  assert.equal(AMOUNT(calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body), PROGRAM.price_cents / 2);
});

test("checkout: unknown program and missing Stripe key are refused", async () => {
  mockFetch([stripeSession()]);
  assert.equal((await call(makeEnv(), "/checkout", { method: "POST", body: { program: "nope" } })).status, 400);
  assert.equal((await call(makeEnv({ STRIPE_SECRET_KEY: "" }), "/checkout", { method: "POST", body: { program: PROGRAM.key } })).status, 503);
});

test("checkout: a Stripe error is reported and the attempt recorded as failed", async () => {
  mockFetch([["/v1/checkout/sessions", () => ({ status: 400, body: { error: { message: "Invalid API key" } } })]]);
  const env = makeEnv();
  const r = await call(env, "/checkout", { method: "POST", body: { program: PROGRAM.key } });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /Invalid API key/);
  assert.equal(env.DB.raw.prepare("SELECT status FROM orders").get().status, "failed");
});

async function startOrder(env) {
  mockFetch([stripeSession()]);
  return (await call(env, "/checkout", { method: "POST", body: { program: PROGRAM.key } })).json.ref;
}
const session = (ref, over = {}) => ({ id: "cs_test_1", client_reference_id: ref, payment_status: "paid", amount_total: PROGRAM.price_cents, payment_intent: "pi_1", customer_details: { email: "maya@example.com", name: "Maya Lopez" }, created: 1792000000, ...over });
const feeRoute = ["/v1/payment_intents/pi_1", () => ({ body: { latest_charge: { balance_transaction: { fee: 755 } } } })];

test("webhook: bad, missing and stale signatures are rejected", async () => {
  mockFetch();
  const env = makeEnv();
  const evt = { type: "checkout.session.completed", data: { object: {} } };
  assert.equal((await signedWebhook(env, evt, { secret: "wrong" })).status, 400);
  assert.equal((await signedWebhook(env, evt, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  assert.equal((await call(env, "/webhooks/stripe", { method: "POST", body: "{}", origin: null })).status, 400);
});

test("webhook: completed checkout marks the order paid, records the fee, emails client and owner once", async () => {
  const env = makeEnv();
  const ref = await startOrder(env);
  const calls = mockFetch([feeRoute]);
  const evt = { type: "checkout.session.completed", data: { object: session(ref) } };
  assert.equal((await signedWebhook(env, evt)).status, 200);
  await signedWebhook(env, evt); // Stripe retries; must not double-email
  const o = env.DB.raw.prepare("SELECT * FROM orders WHERE ref = ?").get(ref);
  assert.equal(o.status, "paid");
  assert.equal(o.paid_cents, PROGRAM.price_cents);
  assert.equal(o.fee_cents, 755);
  assert.equal(o.email, "maya@example.com");
  assert.equal(o.name, "Maya Lopez");
  const sent = emails(calls);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].to, ["maya@example.com"]);
  assert.match(sent[0].text, /intake form/);
  assert.deepEqual(sent[1].to, ["owner@thrive.test"]);
  assert.match(sent[1].text, /PAID/);
});

test("webhook: an unpaid completed session (bank delay) does not mark paid", async () => {
  const env = makeEnv();
  const ref = await startOrder(env);
  mockFetch([feeRoute]);
  await signedWebhook(env, { type: "checkout.session.completed", data: { object: session(ref, { payment_status: "unpaid" }) } });
  assert.equal(env.DB.raw.prepare("SELECT status FROM orders WHERE ref = ?").get(ref).status, "checkout_started");
});

test("webhook: a full refund marks the order refunded and it stays refunded", async () => {
  const env = makeEnv();
  const ref = await startOrder(env);
  mockFetch([feeRoute]);
  await signedWebhook(env, { type: "checkout.session.completed", data: { object: session(ref) } });
  await signedWebhook(env, { type: "charge.refunded", data: { object: { payment_intent: "pi_1", amount_refunded: PROGRAM.price_cents } } });
  assert.equal(env.DB.raw.prepare("SELECT status FROM orders WHERE ref = ?").get(ref).status, "refunded");
  await signedWebhook(env, { type: "checkout.session.completed", data: { object: session(ref) } });
  assert.equal(env.DB.raw.prepare("SELECT status FROM orders WHERE ref = ?").get(ref).status, "refunded");
});

test("thanks page status: asks Stripe directly when the webhook is late", async () => {
  const env = makeEnv();
  const ref = await startOrder(env);
  mockFetch([["/v1/checkout/sessions/cs_test_1", () => ({ body: session(ref) })], feeRoute]);
  const r = await call(env, "/order/status?ref=" + ref);
  assert.equal(r.json.status, "paid");
  assert.equal(r.json.program, PROGRAM.name);
});

test("thanks page status: pending while unpaid, 400 on a malformed ref", async () => {
  const env = makeEnv();
  const ref = await startOrder(env);
  mockFetch([["/v1/checkout/sessions/cs_test_1", () => ({ body: session(ref, { payment_status: "unpaid" }) })]]);
  assert.equal((await call(env, "/order/status?ref=" + ref)).json.status, "pending");
  assert.equal((await call(env, "/order/status?ref=x' OR 1=1")).status, 400);
});

test("hourly sweep catches a paid order with no webhook", async () => {
  const env = makeEnv();
  const ref = await startOrder(env);
  mockFetch([["/v1/checkout/sessions/cs_test_1", () => ({ body: session(ref) })], feeRoute]);
  const { sweepUnpaid } = await import("../src/payments.js");
  assert.equal((await sweepUnpaid(env)).checked, 1);
  assert.equal(env.DB.raw.prepare("SELECT status FROM orders WHERE ref = ?").get(ref).status, "paid");
});

const PLANNED = BUSINESS.programs.find((p) => p.plan);

async function startPlan(env) {
  const calls = mockFetch([stripeSession("cs_plan")]);
  const r = await call(env, "/checkout", { method: "POST", body: { program: PLANNED.key, plan: true } });
  return { ref: r.json.ref, sent: calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body };
}
const planSession = (ref) => ({ id: "cs_plan", mode: "subscription", client_reference_id: ref, payment_status: "paid", amount_total: PLANNED.plan.payment_cents, subscription: "sub_1", invoice: "in_1", customer_details: { email: "maya@example.com", name: "Maya Lopez" }, created: 1792000000 });
const invoice = (id, n, ref) => ({ id, subscription: "sub_1", amount_paid: PLANNED.plan.payment_cents, payment_intent: "pi_" + id, subscription_details: { metadata: { ref } }, status_transitions: { paid_at: 1792000000 + n * 2600000 } });
const planRoutes = (cancels) => [["/v1/subscriptions/sub_1", (url, body) => { cancels.push(body); return { body: {} }; }], ["/v1/payment_intents/", () => ({ body: { latest_charge: { balance_transaction: { fee: 552 } } } })]];

test("plan checkout: monthly subscription at the installment price, order total is the full plan", async () => {
  const env = makeEnv();
  const { ref, sent } = await startPlan(env);
  assert.equal(sent.mode, "subscription");
  assert.equal(AMOUNT(sent), PLANNED.plan.payment_cents);
  assert.equal(sent["line_items[0][price_data][recurring][interval]"], "month");
  assert.equal(sent["subscription_data[metadata][ref]"], ref);
  assert.equal(sent.payment_intent_data, undefined);
  const o = env.DB.raw.prepare("SELECT * FROM orders WHERE ref = ?").get(ref);
  assert.equal(o.amount_cents, PLANNED.plan.payments * PLANNED.plan.payment_cents);
  assert.equal(o.plan_payments, PLANNED.plan.payments);
});

test("plan checkout: plan flag on a program without a plan charges in full", async () => {
  const other = BUSINESS.programs.find((p) => !p.plan);
  const calls = mockFetch([stripeSession()]);
  await call(makeEnv(), "/checkout", { method: "POST", body: { program: other.key, plan: true } });
  const sent = calls.find((c) => c.url.endsWith("/v1/checkout/sessions")).body;
  assert.equal(sent.mode, "payment");
  assert.equal(AMOUNT(sent), other.price_cents);
});

test("plan: three payments recorded once each, then the subscription is set to end", async () => {
  const env = makeEnv();
  const { ref } = await startPlan(env);
  const cancels = [];
  const calls = mockFetch(planRoutes(cancels));
  await signedWebhook(env, { type: "checkout.session.completed", data: { object: planSession(ref) } });
  await signedWebhook(env, { type: "invoice.paid", data: { object: invoice("in_1", 0, ref) } }); // same first payment, must not double-count
  let o = env.DB.raw.prepare("SELECT * FROM orders WHERE ref = ?").get(ref);
  assert.equal(o.status, "paid");
  assert.equal(o.paid_cents, PLANNED.plan.payment_cents);
  assert.equal(cancels.length, 0);
  assert.match(emails(calls)[0].text, /payment 1 of 3/);
  await signedWebhook(env, { type: "invoice.paid", data: { object: invoice("in_2", 1, ref) } });
  await signedWebhook(env, { type: "invoice.paid", data: { object: invoice("in_2", 1, ref) } }); // retry
  assert.equal(cancels.length, 0);
  await signedWebhook(env, { type: "invoice.paid", data: { object: invoice("in_3", 2, ref) } });
  o = env.DB.raw.prepare("SELECT * FROM orders WHERE ref = ?").get(ref);
  assert.equal(o.paid_cents, 3 * PLANNED.plan.payment_cents);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM installments WHERE ref = ?").get(ref).n, 3);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].cancel_at_period_end, "true");
  const alerts = emails(calls).filter((e) => /Payment \d of 3/.test(e.text));
  assert.equal(alerts.length, 2);
  assert.match(alerts[1].text, /Plan complete/);
  assert.equal(emails(calls).filter((e) => e.to[0] === "maya@example.com").length, 1);
});

test("plan: first invoice arriving before checkout completion still settles the order once", async () => {
  const env = makeEnv();
  const { ref } = await startPlan(env);
  const calls = mockFetch(planRoutes([]));
  await signedWebhook(env, { type: "invoice.paid", data: { object: { ...invoice("in_1", 0, ref), customer_email: "maya@example.com" } } });
  await signedWebhook(env, { type: "checkout.session.completed", data: { object: planSession(ref) } });
  const o = env.DB.raw.prepare("SELECT * FROM orders WHERE ref = ?").get(ref);
  assert.equal(o.status, "paid");
  assert.equal(o.subscription_id, "sub_1");
  assert.equal(o.paid_cents, PLANNED.plan.payment_cents);
  assert.equal(emails(calls).filter((e) => e.to[0] === "maya@example.com").length, 1);
});

test("plan: a failed monthly payment alerts the owner", async () => {
  const env = makeEnv();
  const { ref } = await startPlan(env);
  const calls = mockFetch(planRoutes([]));
  await signedWebhook(env, { type: "checkout.session.completed", data: { object: planSession(ref) } });
  await signedWebhook(env, { type: "invoice.payment_failed", data: { object: invoice("in_2", 1, ref) } });
  assert.ok(emails(calls).some((e) => /monthly payment failed/.test(e.text)));
});

test("plan: refunding one installment lowers what was paid", async () => {
  const env = makeEnv();
  const { ref } = await startPlan(env);
  mockFetch(planRoutes([]));
  await signedWebhook(env, { type: "checkout.session.completed", data: { object: planSession(ref) } });
  await signedWebhook(env, { type: "invoice.paid", data: { object: invoice("in_2", 1, ref) } });
  await signedWebhook(env, { type: "charge.refunded", data: { object: { payment_intent: "pi_in_2", amount_refunded: PLANNED.plan.payment_cents } } });
  const o = env.DB.raw.prepare("SELECT * FROM orders WHERE ref = ?").get(ref);
  assert.equal(o.refunded_cents, PLANNED.plan.payment_cents);
  assert.equal(o.fee_cents, 552);
});

test("admin page needs the password and then lists requests", async () => {
  const env = makeEnv();
  mockFetch();
  await call(env, "/submit", { method: "POST", body: { name: "Maya Lopez", email: "maya@example.com" } });
  assert.equal((await call(env, "/admin")).status, 401);
  const r = await call(env, "/admin", { headers: { Authorization: "Basic " + btoa("x:pw") } });
  assert.equal(r.status, 200);
  assert.match(r.text, /Maya Lopez/);
});
