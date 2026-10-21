// Shared helpers: responses, CORS, admin auth, rate limiting, crypto. No dependencies.

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// Dashboard-pasted values sometimes carry a trailing space or line break; strip them from every string setting.
export function cleanEnv(env) {
  const out = {};
  for (const k of Object.keys(env)) { const v = env[k]; out[k] = typeof v === "string" ? v.trim() : v; }
  return out;
}

export function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Vary": "Origin" };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function requireOrigin(cors) {
  return cors["Access-Control-Allow-Origin"] ? null : json({ error: "Origin not allowed" }, 403, cors);
}

// Until Cloudflare Access sits in front of /admin, admin routes use HTTP Basic with ADMIN_KEY.
export function requireAdmin(request, env) {
  const unauthorized = () => new Response("Sign in with any username and the admin password.", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Admin", charset="UTF-8"' } });
  if (!env.ADMIN_KEY) return new Response("ADMIN_KEY is not set on the worker.", { status: 503 });
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return unauthorized();
  let decoded = ""; try { decoded = atob(h.slice(6)); } catch { return unauthorized(); }
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(pass, env.ADMIN_KEY) ? null : unauthorized();
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const RATE = new Map(); // ip -> [timestamps], per isolate; a light brake on form spam
export function rateLimited(ip, limit = 8, windowMs = 600000) {
  const now = Date.now(), arr = (RATE.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); RATE.set(ip, arr); return arr.length > limit;
}
export function resetRateLimits() { RATE.clear(); }

export async function hmacBase64(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function e164(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return undefined;
}

export function newRef() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "TG-" + [...bytes].map((b) => a[b % a.length]).join("");
}

export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ""));
export const dollars = (cents) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 });
