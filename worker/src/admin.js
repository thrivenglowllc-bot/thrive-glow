// Owner page at /admin: recent call requests and payments, readable on a phone.
import { BUSINESS } from "./business.js";
import { dollars } from "./core.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: BUSINESS.time_zone, month: "short", day: "numeric" }) : "");

export async function adminPage(env) {
  const inq = (await env.DB.prepare(`SELECT * FROM inquiries ORDER BY id DESC LIMIT 50`).all()).results;
  const ord = (await env.DB.prepare(`SELECT * FROM orders WHERE status IN ('paid','refunded') ORDER BY paid_at DESC LIMIT 50`).all()).results;
  const month = new Date().toISOString().slice(0, 7);
  const m = await env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(paid_cents - refunded_cents),0) net, COALESCE(SUM(fee_cents),0) fees FROM orders WHERE status IN ('paid','refunded') AND substr(paid_at,1,7) = ?`).bind(month).first();
  const calls = await env.DB.prepare(`SELECT COUNT(*) n FROM inquiries WHERE substr(created_at,1,7) = ?`).bind(month).first();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(BUSINESS.name)} admin</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f1f2ee;color:#1f3634}main{max-width:60rem;margin:0 auto;padding:1rem}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem}.tile{background:#fff;border-radius:.5rem;padding:.8rem}.tile b{display:block;font-size:1.5rem}
.row{background:#fff;border-radius:.5rem;padding:.75rem .9rem;margin:.5rem 0}.row small{color:#4a5e5b}</style></head><body><main>
<h1>${esc(BUSINESS.name)}: this month</h1>
<div class="tiles"><div class="tile">Programs sold<b>${m.n}</b></div><div class="tile">Revenue after refunds<b>${dollars(m.net)}</b></div><div class="tile">Card fees<b>${dollars(m.fees)}</b></div><div class="tile">Call requests<b>${calls.n}</b></div></div>
<h2>Call requests</h2>${inq.length ? inq.map((r) => `<div class="row"><b>${esc(r.name)}</b> <small>${day(r.created_at)}${r.emailed === 3 ? "" : " · email problem"}</small><br><a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.phone ? " · " + esc(r.phone) : ""}<br><small>${esc(r.interest || "Not sure yet")}${r.heard ? " · found you via " + esc(r.heard) : ""}</small>${r.goal ? `<br>${esc(r.goal)}` : ""}</div>`).join("") : "<p>No requests yet. They appear here as soon as someone fills in the free-call form.</p>"}
<h2>Payments</h2>${ord.length ? ord.map((o) => `<div class="row"><b>${dollars(o.paid_cents)}</b> ${esc(o.program_name)} <small>${day(o.paid_at)} · ${esc(o.ref)}${o.status === "refunded" ? " · refunded" : ""}</small><br>${esc(o.name || "")} ${o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : ""}</div>`).join("") : "<p>No payments yet.</p>"}
</main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
