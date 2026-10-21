import { httpServerHandler } from "cloudflare:node";
import { assertRequiredEnv } from "../../packages/shared/src/env.js";

const SERVICE = "operations-api";
const REQUIRED_ENV = [
  "AUTH_SUPABASE_URL",
  "AUTH_SUPABASE_ANON_KEY",
  "ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY",
  "ALLOWED_ORIGINS",
  "PRODUCTS_SUPABASE_URL",
  "PRODUCTS_SUPABASE_SERVICE_ROLE_KEY",
  "ORDERS_SUPABASE_URL",
  "ORDERS_SUPABASE_SERVICE_ROLE_KEY",
  "OPERATIONS_SUPABASE_URL",
  "OPERATIONS_SUPABASE_SERVICE_ROLE_KEY",
  "OWNER_SESSION_SECRET",
  "VINE_OWNER_EMAIL",
  "VINE_OWNER_USER_ID",
  "CHECKOUT_ENABLED",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_CALLBACK_URL",
  "BANK_TRANSFER_ACCOUNT_NAME",
  "BANK_TRANSFER_ACCOUNT_NUMBER",
  "BANK_TRANSFER_BANK_NAME",
  "SMS_PROVIDER",
  "RESEND_API_KEY",
  "VINE_EMAIL_FROM",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GMAIL_SENDER_EMAIL"
];

let runtimePromise;

async function getRuntime(env) {
  assertRequiredEnv(env, SERVICE, REQUIRED_ENV);

  if (!runtimePromise) {
    runtimePromise = (async () => {
      const service = await import("../../services/operations-api/src/server.js");
      return {
        handler: httpServerHandler({ port: 10000 }),
        runScheduledOperations: service.runScheduledOperations
      };
    })();
  }

  return runtimePromise;
}

export default {
  async fetch(request, env, ctx) {
    const runtime = await getRuntime(env);
    return runtime.handler.fetch(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    const runtime = await getRuntime(env);
    ctx.waitUntil(runtime.runScheduledOperations());
  }
};
