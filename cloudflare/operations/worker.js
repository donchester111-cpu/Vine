import { httpServerHandler } from "cloudflare:node";
import { runScheduledOperations } from "../../services/operations-api/src/server.js";

const httpServer = httpServerHandler({ port: 10000 });

export default {
  ...httpServer,
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runScheduledOperations());
  }
};
