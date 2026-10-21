# Thrive & Glow website and back end

- `business.json`: names, contact details and programs. The one file to edit for business facts.
- `site-src/`: page templates. `node scripts/build.mjs` stamps `business.json` into them and writes `docs/`, which GitHub Pages publishes.
- `worker/`: Cloudflare Worker. Discovery-call requests (`/submit`), Stripe Checkout (`/checkout`), Stripe webhook (`/webhooks/stripe`), thanks-page status (`/order/status`), owner page (`/admin`), hourly payment sweep.
- `worker/migrations/`: database changes, applied on deploy. Never edit an applied file; add the next number.
- `.github/workflows/worker.yml`: on every push, checks the site matches `business.json`, runs the tests, then applies migrations and deploys the worker (once the Cloudflare secrets exist).

Client health information never goes through this site. Intake, history and labs stay in the practitioner platform.

## Settings (values live in Cloudflare or GitHub, never in this repo or in chat)

| Name | Where | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | Cloudflare secret | `sk_test_...` while testing, `sk_live_...` when live |
| `STRIPE_WEBHOOK_SECRET` | Cloudflare secret | `whsec_...` from the Stripe webhook for `/webhooks/stripe`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` |
| `RESEND_API_KEY` | Cloudflare secret | Email sending |
| `ADMIN_KEY` | Cloudflare secret | Password for `/admin` until Cloudflare Access replaces it |
| `FROM_EMAIL`, `ALERT_TO`, `DEPOSIT_PERCENT` | Cloudflare variable, optional | Sender (must be a mailbox someone reads), alert recipients, deposit |
| `SITE_URL`, `ALLOWED_ORIGINS`, `SUPPORT_EMAIL` | `worker/wrangler.toml` | Links in emails, CORS allow-list, the real inbox |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets | Lets every push deploy the worker |

## Rules
- No secrets in chat. Anything pasted in a chat is rotated the same day.
- Two-factor on GitHub, Cloudflare, Stripe, Resend, GoDaddy.
- Never test payments with your own real card; use Stripe test mode (card 4242 4242 4242 4242).
- Check every page at phone width before pushing.
