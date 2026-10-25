import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { PicanvaError } from "./service.mjs";
import { PiprogramError } from "./piprogram.mjs";

const CANVA_PREFIX = "/api/v1/canva/";

function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOrKey(request) {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  if (typeof request.headers["x-api-key"] === "string") return request.headers["x-api-key"].trim();
  return undefined;
}

export function buildApp({ config, service, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });

  // The Canva app runs inside Canva's editor iframe, so its origin is not known in advance. CORS is
  // open for the /api/v1/canva/ routes only; they still need the API key when one is configured.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith(CANVA_PREFIX)) return;
    reply.header("Access-Control-Allow-Origin", "*");
    if (request.method === "OPTIONS") {
      return reply
        .code(204)
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key")
        .header("Access-Control-Max-Age", "600")
        .send();
    }
  });

  // Auth for writes. Exact prefix match on the route, not a substring of the URL.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const path = request.url.split("?")[0];
    if (!path.startsWith(CANVA_PREFIX)) return;
    if (!config.apiKey) return;
    const given = bearerOrKey(request);
    if (given && sameSecret(given, config.apiKey)) return;
    return reply.code(401).send({
      error: { code: "UNAUTHORIZED", message: "Valid API key required (Bearer token or X-Api-Key)" }
    });
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof PicanvaError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
      });
    }
    if (err instanceof PiprogramError) {
      return reply.code(err.status).send({ error: { code: "PIPROGRAM_ERROR", message: err.message } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: "BAD_REQUEST", message: err.message } });
    }
    request.log.error(err);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Unexpected error" } });
  });

  app.get("/health", async () => ({ status: "ok", mode: config.mode, piprogram: config.piprogramUrl }));

  app.get("/api/v1/canva/items", async () => ({ items: service.listItems() }));

  app.get("/api/v1/canva/items/:itemId", async (request, reply) => {
    const item = service.getItem(request.params.itemId);
    if (!item) {
      return reply.code(404).send({ error: { code: "CANVA_ITEM_NOT_FOUND", message: `Unknown Canva item: ${request.params.itemId}` } });
    }
    return item;
  });

  app.post("/api/v1/canva/push", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return reply.code(422).send({ error: { code: "INVALID_BODY", message: "Body must be a JSON object" } });
    }
    const item = await service.push(
      {
        designId: body.designId,
        viewUrl: body.viewUrl,
        title: body.title,
        exportUrls: Array.isArray(body.exportUrls) ? body.exportUrls : undefined,
        exportFormat: body.exportFormat,
        autoExport: body.autoExport === true,
        orientation: body.orientation,
        targetPipelineId: body.targetPipelineId,
        cueImmediately: typeof body.cueImmediately === "boolean" ? body.cueImmediately : undefined
      },
      { pushedFromCanvaApp: body.pushedFromCanvaApp === true }
    );
    return reply.code(201).send({ accepted: true, item });
  });

  app.post("/api/v1/canva/control", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      return reply.code(422).send({ error: { code: "INVALID_BODY", message: "Body must be a JSON object" } });
    }
    const result = await service.control({
      action: body.action,
      designId: typeof body.designId === "string" ? body.designId : undefined,
      targetPipelineId: typeof body.targetPipelineId === "string" ? body.targetPipelineId : undefined,
      pageNumber: Number.isInteger(body.pageNumber) ? body.pageNumber : undefined,
      fadeToBlack: typeof body.fadeToBlack === "boolean" ? body.fadeToBlack : undefined,
      toggle: typeof body.toggle === "boolean" ? body.toggle : undefined,
      audioEnabled: typeof body.audioEnabled === "boolean" ? body.audioEnabled : undefined
    });
    return reply.code(200).send(result);
  });

  return app;
}
