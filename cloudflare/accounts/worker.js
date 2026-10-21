import { httpServerHandler } from "cloudflare:node";
import { assertRequiredEnv } from "../../packages/shared/src/env.js";

const SERVICE = "accounts-api";
const REQUIRED_ENV = [
  // Required to initialize Supabase Auth and the accounts-admin client.
  "AUTH_SUPABASE_URL",
  "AUTH_SUPABASE_ANON_KEY",
  "ACCOUNTS_SUPABASE_SERVICE_ROLE_KEY"
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
