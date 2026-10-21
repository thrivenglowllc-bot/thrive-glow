// Test harness: an in-memory D1 stand-in on node:sqlite, the migrations applied, and a fetch mock
// that records outgoing calls (Resend, Stripe) and answers them from a routing table.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { hmacHex, resetRateLimits } from "../src/core.js";

const here = dirname(fileURLToPath(import.meta.url));

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(here, "../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql) => {
    let args = [];
    const s = {
      bind(...a) { args = a.map((v) => (v === undefined ? null : v)); return s; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
    return s;
  };
  return { prepare: stmt, async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; }, raw: db };
}

export const ORIGIN = "https://thrive.test";

export function makeEnv(extra = {}) {
  return {
    DB: makeD1(),
    ALLOWED_ORIGINS: ORIGIN,
    SITE_URL: ORIGIN,
    SUPPORT_EMAIL: "owner@thrive.test",
    RESEND_API_KEY: "re_test",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    ADMIN_KEY: "pw",
    ...extra,
  };
}

// routes: array of [predicate(url, init) | string-substring, responder(url, init) -> {status, body}]
export function mockFetch(routes = []) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = String(input);
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = Object.fromEntries(new URLSearchParams(init.body)); } }
    calls.push({ url, method: init.method || "GET", body });
    for (const [match, respond] of routes) {
      if (typeof match === "string" ? url.includes(match) : match(url, init)) {
        const { status = 200, body: rb = {} } = await respond(url, body);
        return new Response(JSON.stringify(rb), { status, headers: { "Content-Type": "application/json" } });
      }
    }
    if (url.includes("api.resend.com")) return new Response(JSON.stringify({ id: "em_" + calls.length }), { status: 200 });
    return new Response(JSON.stringify({ error: "unmocked " + url }), { status: 500 });
  };
  globalThis.fetch = fn;
  resetRateLimits();
  return calls;
}

export async function call(env, path, { method = "GET", body, headers = {}, origin = ORIGIN } = {}) {
  const h = { ...(origin ? { Origin: origin } : {}), ...headers };
  if (body !== undefined && typeof body !== "string") { h["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  const res = await worker.fetch(new Request("https://worker.test" + path, { method, headers: h, body }), env, { waitUntil() {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

export async function signedWebhook(env, event, { t = Math.floor(Date.now() / 1000), secret = env.STRIPE_WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(event);
  const sig = await hmacHex(secret, `${t}.${raw}`);
  return call(env, "/webhooks/stripe", { method: "POST", body: raw, origin: null, headers: { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" } });
}

export const emails = (calls) => calls.filter((c) => c.url.includes("api.resend.com")).map((c) => c.body);
