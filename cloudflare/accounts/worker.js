import { httpServerHandler } from "cloudflare:node";
import "../../services/accounts-api/src/server.js";

export default httpServerHandler({ port: 10000 });
