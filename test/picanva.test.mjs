import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { designIdFrom, isAllowedAssetUrl, mediaFormat, exportPayload } from "../src/canva.mjs";
import { createPiprogramClient } from "../src/piprogram.mjs";
import { createPicanvaService } from "../src/service.mjs";
import { buildApp } from "../src/app.mjs";

const PIPROGRAM = "http://piprogram.test:3000";
const ASSET_A = "https://export.canva.com/abc/page-1.png";
const ASSET_B = "https://export.canva.com/abc/page-2.png";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

// Fake network: piprogram answers with ids, Canva export hosts answer with bytes.
function fakeNetwork({ piprogramDown = false, assetStatus = 200 } = {}) {
  const calls = [];
  let nextId = 1;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: href, method: init.method ?? "GET", body });
    if (href.startsWith(PIPROGRAM)) {
      if (piprogramDown) throw new Error("connect ECONNREFUSED");
      if (href.endsWith("/items/media")) return json({ id: `pg-item-${nextId++}`, kind: body.kind });
      return json({ ok: true });
    }
    if (href.startsWith("https://export.canva.com/")) {
      if (assetStatus !== 200) return new Response("no", { status: assetStatus });
      return new Response(Buffer.from(`bytes:${href}`), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetchImpl };
}

function setup({ env = {}, network = fakeNetwork() } = {}) {
  const config = loadConfig({ PICANVA_PIPROGRAM_URL: PIPROGRAM, ...env });
  const piprogram = createPiprogramClient({ baseUrl: PIPROGRAM, timeoutMs: 1000, fetchImpl: network.fetchImpl });
  const service = createPicanvaService({ config, piprogram, fetchImpl: network.fetchImpl });
  const app = buildApp({ config, service });
  return { app, network, config };
}

test("config: production needs an API key, piprogram URL is required, mode is checked", () => {
  assert.throws(() => loadConfig({ PICANVA_PIPROGRAM_URL: PIPROGRAM, PICANVA_MODE: "production" }), /PICANVA_API_KEY/);
  assert.throws(() => loadConfig({}), /PICANVA_PIPROGRAM_URL/);
  assert.throws(() => loadConfig({ PICANVA_PIPROGRAM_URL: PIPROGRAM, PICANVA_MODE: "lab" }), /PICANVA_MODE/);
  assert.throws(() => loadConfig({ PICANVA_PIPROGRAM_URL: "ftp://x" }), /PICANVA_PIPROGRAM_URL/);
  const cfg = loadConfig({ PICANVA_PIPROGRAM_URL: `${PIPROGRAM}/` });
  assert.equal(cfg.piprogramUrl, PIPROGRAM);
  assert.equal(cfg.port, 3100);
  assert.deepEqual(cfg.assetHosts, ["canva.com", "canva-usercontent.com"]);
});

test("designIdFrom accepts a bare id or a design URL and rejects the rest", () => {
  assert.equal(designIdFrom("DAF_CHURCH_2026"), "DAF_CHURCH_2026");
  assert.equal(designIdFrom("https://www.canva.com/design/DAFabc123/view?utm=x"), "DAFabc123");
  assert.equal(designIdFrom("javascript:alert(1)"), null);
  assert.equal(designIdFrom("ab"), null);
  assert.equal(designIdFrom(""), null);
  assert.equal(designIdFrom(undefined), null);
});

test("asset URLs must be https on an allowed Canva host", () => {
  const hosts = ["canva.com"];
  assert.equal(isAllowedAssetUrl("https://export.canva.com/x.png", hosts), true);
  assert.equal(isAllowedAssetUrl("http://export.canva.com/x.png", hosts), false);
  assert.equal(isAllowedAssetUrl("https://canva.com.evil.example/x.png", hosts), false);
  assert.equal(isAllowedAssetUrl("https://user:pw@canva.com/x.png", hosts), false);
});

test("media format and Canva export payload", () => {
  assert.deepEqual(mediaFormat("mp4"), { kind: "video", ext: "mp4", mimeType: "video/mp4" });
  assert.equal(mediaFormat("png").kind, "image");
  assert.deepEqual(exportPayload("D1", "mp4", "portrait").format, { type: "mp4", quality: "vertical_1080p" });
});

test("push hands every exported page to piprogram; only the first is cued", async () => {
  const { app, network } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/canva/push",
    payload: { designId: "DAF_CHURCH_2026", title: "Sunday", exportUrls: [ASSET_A, ASSET_B], exportFormat: "png", targetPipelineId: "PiPGM2" }
  });
  assert.equal(res.statusCode, 201);
  const { item } = res.json();
  assert.equal(item.status, "handed_off");
  assert.equal(item.targetPipelineId, "PiPGM2");
  assert.equal(item.pages.length, 2);

  const media = network.calls.filter((c) => c.url.endsWith("/api/v1/pipgm/items/media"));
  assert.equal(media.length, 2);
  assert.equal(media[0].body.kind, "image");
  assert.equal(media[0].body.cueImmediately, true);
  assert.equal(media[1].body.cueImmediately, false);
  assert.equal(media[0].body.targetPipelineId, "PiPGM2");
  assert.equal(media[0].body.dataBase64, Buffer.from(`bytes:${ASSET_A}`).toString("base64"));
});

test("embed-only push is refused until piprogram can show Canva items", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "POST", url: "/api/v1/canva/push", payload: { designId: "DAF_CHURCH_2026" } });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "NO_EXPORTED_PAGES");
});

test("autoExport without a Canva token is refused with a clear code", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "POST", url: "/api/v1/canva/push", payload: { designId: "DAF_CHURCH_2026", autoExport: true } });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "CANVA_CONNECT_NOT_CONFIGURED");
});

test("asset from a host outside the allowlist is refused and the item is marked partial", async () => {
  const { app } = setup();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/canva/push",
    payload: { designId: "DAF_CHURCH_2026", exportUrls: ["https://evil.example/x.png"] }
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.code, "ASSET_HOST_NOT_ALLOWED");
  assert.equal(res.json().error.details.item.status, "partial");
});

test("piprogram being down gives 502 HANDOFF_FAILED", async () => {
  const { app } = setup({ network: fakeNetwork({ piprogramDown: true }) });
  const res = await app.inject({ method: "POST", url: "/api/v1/canva/push", payload: { designId: "DAF_CHURCH_2026", exportUrls: [ASSET_A] } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, "HANDOFF_FAILED");
});

test("gotoPage jumps piprogram to the item of that page", async () => {
  const { app, network } = setup();
  const pushed = await app.inject({
    method: "POST",
    url: "/api/v1/canva/push",
    payload: { designId: "DAF_CHURCH_2026", exportUrls: [ASSET_A, ASSET_B] }
  });
  const pages = pushed.json().item.pages;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/canva/control",
    payload: { action: "gotoPage", designId: "DAF_CHURCH_2026", pageNumber: 2 }
  });
  assert.equal(res.statusCode, 200);
  const control = network.calls.filter((c) => c.url.endsWith("/control")).pop();
  assert.equal(control.url, `${PIPROGRAM}/api/v1/pipgm/pipelines/PiPGM1/control`);
  assert.deepEqual(control.body, { action: "gotoItem", itemId: pages[1].piprogramItemId });

  const missing = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "gotoPage", designId: "DAF_CHURCH_2026", pageNumber: 9 } });
  assert.equal(missing.json().error.code, "PAGE_NOT_FOUND");
});

test("ftb and mute map to piprogram; targetPipelineId all reaches every pipeline", async () => {
  const { app, network } = setup();
  const res = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "ftb", targetPipelineId: "all" } });
  assert.equal(res.statusCode, 200);
  const ftbCalls = network.calls.filter((c) => c.url.includes("/ftb"));
  assert.equal(ftbCalls.length, 3);
  assert.deepEqual(ftbCalls[0].body, { toggle: true });

  await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "mute", targetPipelineId: "PiPGM3", audioEnabled: true } });
  const audio = network.calls.filter((c) => c.url.includes("/audio")).pop();
  assert.equal(audio.url, `${PIPROGRAM}/api/v1/pipgm/pipelines/PiPGM3/audio`);
  assert.deepEqual(audio.body, { audioEnabled: true, toggle: false });
});

test("unknown control action and pipeline are refused", async () => {
  const { app } = setup();
  const bad = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "explode" } });
  assert.equal(bad.json().error.code, "INVALID_CANVA_CONTROL_ACTION");
  const pipe = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "next", targetPipelineId: "PiPGM9" } });
  assert.equal(pipe.json().error.code, "INVALID_PIPELINE_ID");
});

test("with PICANVA_API_KEY set, writes need the key; reads stay open", async () => {
  const { app } = setup({ env: { PICANVA_API_KEY: "s3cret-key" } });
  const denied = await app.inject({ method: "POST", url: "/api/v1/canva/control", payload: { action: "next" } });
  assert.equal(denied.statusCode, 401);
  const wrong = await app.inject({ method: "POST", url: "/api/v1/canva/control", headers: { authorization: "Bearer nope" }, payload: { action: "next" } });
  assert.equal(wrong.statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/api/v1/canva/control", headers: { "x-api-key": "s3cret-key" }, payload: { action: "next" } });
  assert.equal(ok.statusCode, 200);
  const list = await app.inject({ method: "GET", url: "/api/v1/canva/items" });
  assert.equal(list.statusCode, 200);
});

test("CORS preflight for the Canva routes answers without credentials", async () => {
  const { app } = setup({ env: { PICANVA_API_KEY: "s3cret-key" } });
  const res = await app.inject({ method: "OPTIONS", url: "/api/v1/canva/push", headers: { origin: "https://www.canva.com" } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("health reports mode and piprogram target", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.json().status, "ok");
  assert.equal(res.json().piprogram, PIPROGRAM);
});

test("piprogram calls send the x-api-key header the piprogram spec declares", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(init.headers);
    return json({ id: "pg-1" });
  };
  const client = createPiprogramClient({ baseUrl: PIPROGRAM, apiKey: "pg-key", timeoutMs: 1000, fetchImpl });
  await client.createMediaItem({ kind: "image", filename: "a.png", dataBase64: "AA==" });
  assert.equal(seen[0]["x-api-key"], "pg-key");
  assert.equal(seen[0].authorization, undefined);
});

test("asset size is capped so base64 bodies stay under piprogram's 50 MB limit", () => {
  assert.throws(() => loadConfig({ PICANVA_PIPROGRAM_URL: PIPROGRAM, PICANVA_MAX_ASSET_BYTES: String(40 * 1024 * 1024) }), /PICANVA_MAX_ASSET_BYTES/);
  assert.equal(loadConfig({ PICANVA_PIPROGRAM_URL: PIPROGRAM }).maxAssetBytes, 30 * 1024 * 1024);
});
