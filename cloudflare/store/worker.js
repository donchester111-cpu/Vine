import { httpServerHandler } from "cloudflare:node";
import { assertRequiredEnv } from "../../packages/shared/src/env.js";

const SERVICE = "store-api";
const REQUIRED_ENV = [
  // Required to initialize every Supabase client used by the Store API.
  "AUTH_SUPABASE_URL",
  "AUTH_SUPABASE_ANON_KEY",
  "ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY",
  "PRODUCTS_SUPABASE_URL",
  "PRODUCTS_SUPABASE_SERVICE_ROLE_KEY",
  "ORDERS_SUPABASE_URL",
  "ORDERS_SUPABASE_SERVICE_ROLE_KEY"
];

let runtimePromise;

async function getRuntime(env) {
  assertRequiredEnv(env, SERVICE, REQUIRED_ENV);

  if (!runtimePromise) {
    runtimePromise = (async () => {
      await import("../../services/store-api/src/server.js");
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
