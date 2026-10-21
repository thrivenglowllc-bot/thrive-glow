// Routes only. The work lives in the modules next to this file.
import { json, cleanEnv, corsHeaders, requireOrigin, requireAdmin } from "./core.js";
import { submitInquiry } from "./inquiries.js";
import { checkout, orderStatus, stripeWebhook, sweepUnpaid } from "./payments.js";
import { adminPage } from "./admin.js";

export const VERSION = "2026-10-21 v1";

export default {
  async fetch(request, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
    const cors = corsHeaders(request.headers.get("Origin") || "", env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/health") return json({ ok: true, version: VERSION, db: !!env.DB, payments: !env.STRIPE_SECRET_KEY ? "off" : env.STRIPE_SECRET_KEY.startsWith("sk_live") ? "live" : "test", email: !!env.RESEND_API_KEY }, 200, cors);
      if (path === "/submit" && request.method === "POST") return requireOrigin(cors) || await submitInquiry(request, env, cors);
      if (path === "/checkout" && request.method === "POST") return requireOrigin(cors) || await checkout(request, env, cors);
      if (path === "/order/status") return await orderStatus(env, url.searchParams.get("ref"), cors);
      if (path === "/webhooks/stripe" && request.method === "POST") return await stripeWebhook(request, env);
      if (path === "/admin") return requireAdmin(request, env) || await adminPage(env);
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      console.error("Unhandled", e && e.stack || e);
      return json({ error: "Server error" }, 500, cors);
    }
  },
  // Hourly safety net: catch any payment whose webhook never arrived.
  async scheduled(event, rawEnv, ctx) {
    ctx.waitUntil(sweepUnpaid(cleanEnv(rawEnv)));
  },
};
