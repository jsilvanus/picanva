import { loadConfig } from "./config.mjs";
import { createCanvaConnectClient } from "./canva-connect.mjs";
import { createPiprogramClient } from "./piprogram.mjs";
import { createPicanvaService } from "./service.mjs";
import { buildApp } from "./app.mjs";

const config = loadConfig();
if (config.mode === "simulation" && !config.apiKey) {
  console.warn("picanva: PICANVA_API_KEY is not set; write routes are open (simulation mode only)");
}

const piprogram = createPiprogramClient({
  baseUrl: config.piprogramUrl,
  apiKey: config.piprogramApiKey,
  timeoutMs: config.piprogramTimeoutMs
});
const canvaConnect = config.canvaAccessToken
  ? createCanvaConnectClient({ baseUrl: config.canvaApiBaseUrl, accessToken: config.canvaAccessToken })
  : undefined;
const service = createPicanvaService({ config, piprogram, canvaConnect });
const app = buildApp({ config, service, logger: true });

await app.listen({ host: config.host, port: config.port });
