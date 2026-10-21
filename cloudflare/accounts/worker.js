import { httpServerHandler } from "cloudflare:node";
import { assertRequiredEnv } from "../../packages/shared/src/env.js";

const SERVICE = "accounts-api";
const REQUIRED_ENV = [
  "AUTH_SUPABASE_URL",
  "AUTH_SUPABASE_ANON_KEY",
  "ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY",
  "ALLOWED_ORIGINS",
  "OWNER_PASSWORD",
  "OWNER_SESSION_SECRET",
  "VINE_OWNER_EMAIL",
  "VINE_OWNER_USER_ID",
  "VINE_STAFF_INVITE_REDIRECT_URL",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GMAIL_SENDER_EMAIL",
  "RESEND_API_KEY",
  "VINE_EMAIL_FROM",
  "PAYSTACK_SECRET_KEY",
  "SMS_PROVIDER"
];

let runtimePromise;

async function getRuntime(env) {
  assertRequiredEnv(env, SERVICE, REQUIRED_ENV);

  if (!runtimePromise) {
    runtimePromise = (async () => {
      await import("../../services/accounts-api/src/server.js");
      return httpServerHandler({ port: 10000 });
    })();
  }

  return runtimePromise;
}

export default {
  async fetch(request, env, ctx) {
    const runtime = await getRuntime(env);
    return runtime.fetch(request, env, ctx);
  }
};
