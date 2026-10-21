import { httpServerHandler } from "cloudflare:node";
import "../../services/store-api/src/server.js";

export default httpServerHandler({ port: 10000 });
