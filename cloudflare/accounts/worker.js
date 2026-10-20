import { DurableObject } from "cloudflare:workers";

const SERVICE_NAME = "vine-accounts-api";
const IMAGE_NAME = "accounts";
const ENV_KEYS = [
  "NODE_ENV",
  "AUTH_SUPABASE_URL",
  "AUTH_SUPABASE_ANON_KEY",
  "ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY",
  "VINE_OWNER_EMAIL",
  "VINE_OWNER_USER_ID",
  "OWNER_SESSION_SECRET",
  "OWNER_PASSWORD",
  "VINE_STAFF_INVITE_REDIRECT_URL",
  "RESEND_API_KEY",
  "VINE_EMAIL_FROM",
  "GMAIL_SENDER_EMAIL",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "ALLOWED_ORIGINS",
  "PAYSTACK_SECRET_KEY",
  "SMS_PROVIDER"
];
const PORT = 10000;

function containerEnv(env) {
  const values = { PORT: String(PORT), NODE_ENV: "production", SERVICE_NAME };
  for (const key of ENV_KEYS) {
    if (typeof env[key] === "string") values[key] = env[key];
  }
  return values;
}

async function waitForHealth(portFetcher) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await portFetcher.fetch("http://container/health");
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) { lastError = error; }
    await scheduler.wait(250);
  }
  throw new Error("Vine container failed its /health check", { cause: lastError });
}

export class AccountsContainer extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({ image: container.images[IMAGE_NAME], env: containerEnv(this.env), enableInternet: true });
    }
    await container.setInactivityTimeout(15 * 60 * 1000);
    const port = container.getTcpPort(PORT);
    await waitForHealth(port);
    const incoming = new URL(request.url);
    const target = `http://container${incoming.pathname}${incoming.search}`;
    const forwarded = new Request(target, request);
    forwarded.headers.delete("host");
    return port.fetch(forwarded);
  }
}

export default {
  async fetch(request, env) {
    const id = env.ACCOUNTS_CONTAINER.idFromName("vine-accounts-api-primary");
    return env.ACCOUNTS_CONTAINER.get(id).fetch(request);
  }
};
