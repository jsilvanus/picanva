import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../src/config.mjs";
import { isRunningInCanva, exportDesignPages } from "../src/services/canva-sdk.mjs";
import {
  pushContent,
  setupPresentation,
  controlSlide,
  toggleFtb,
  setProjectorPicMute,
  getGatewayStatus,
  setFetchImpl,
  resetFetchImpl,
} from "../src/services/gateway-api.mjs";

beforeEach(() => {
  // Use instant mock fetch during unit tests to avoid network timeouts
  setFetchImpl(async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};

    if (path === "/api/v1/canva/push") {
      return new Response(
        JSON.stringify({
          success: true,
          presentationId: "pres_mock123",
          title: body.title,
          pageCount: body.pages?.length || 0,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      );
    }

    if (path === "/api/v1/canva/setup") {
      return new Response(
        JSON.stringify({
          success: true,
          pipelineId: body.pipelineId,
          matrixRoute: body.matrixRoute,
          picMute: body.unblankProjectors ? false : true,
          currentSlide: body.cueSlide || 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (path === "/api/v1/canva/control") {
      let currentPage = 1;
      let ftb = false;
      if (body.action === "gotoPage") currentPage = body.page;
      if (body.action === "ftb") ftb = body.enabled;
      return new Response(
        JSON.stringify({ success: true, currentPage, ftb }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (path === "/api/v1/canva/projector/pic-mute") {
      return new Response(
        JSON.stringify({ success: true, muted: body.muted }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (path === "/api/v1/canva/status") {
      return new Response(
        JSON.stringify({
          online: true,
          pipelineId: "pipgm1",
          matrixRoute: "both_projectors",
          currentSlide: 1,
          totalSlides: 4,
          ftb: false,
          picMute: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
  });
});

afterEach(() => {
  resetFetchImpl();
});

test("CONFIG initializes with defaults or environment values", () => {
  assert.ok(CONFIG.appName, "appName must be present");
  assert.ok(CONFIG.gatewayUrl, "gatewayUrl must be present");
  assert.strictEqual(CONFIG.gatewayUrl.endsWith("/"), false, "gatewayUrl must not end with a slash");
});

test("canva-sdk detects environment and provides simulated export when outside Canva iframe", async () => {
  const inCanva = isRunningInCanva();
  assert.strictEqual(typeof inCanva, "boolean");

  const exportResult = await exportDesignPages();
  assert.strictEqual(exportResult.status, "completed");
  assert.ok(Array.isArray(exportResult.exportBlobs));
  assert.ok(exportResult.exportBlobs.length > 0);
  assert.ok(exportResult.exportBlobs[0].url);
  assert.strictEqual(exportResult.exportBlobs[0].pageNumber, 1);
});

test("gateway-api executes Step 1 (pushContent) successfully", async () => {
  const pages = [
    { pageNumber: 1, url: "https://export.canva.com/slide-1.png", name: "Intro" },
    { pageNumber: 2, url: "https://export.canva.com/slide-2.png", name: "Scripture" },
  ];

  const res = await pushContent({ title: "Sunday Service", pages });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.presentationId, "pres_mock123");
  assert.strictEqual(res.pageCount, 2);
});

test("gateway-api executes Step 2 (setupPresentation) with pipeline and matrix routing", async () => {
  const res = await setupPresentation({
    presentationId: "pres_123",
    pipelineId: "pipgm1",
    matrixRoute: "both_projectors",
    unblankProjectors: true,
    cueSlide: 1,
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.pipelineId, "pipgm1");
  assert.strictEqual(res.matrixRoute, "both_projectors");
  assert.strictEqual(res.picMute, false);
  assert.strictEqual(res.currentSlide, 1);
});

test("gateway-api executes Step 3 (controlSlide next, prev, gotoPage)", async () => {
  const nextRes = await controlSlide({ pipelineId: "pipgm1", action: "next" });
  assert.strictEqual(nextRes.success, true);

  const prevRes = await controlSlide({ pipelineId: "pipgm1", action: "prev" });
  assert.strictEqual(prevRes.success, true);

  const jumpRes = await controlSlide({ pipelineId: "pipgm1", action: "gotoPage", page: 3 });
  assert.strictEqual(jumpRes.success, true);
  assert.strictEqual(jumpRes.currentPage, 3);
});

test("gateway-api executes Step 3 (toggleFtb)", async () => {
  const ftbOn = await toggleFtb({ pipelineId: "pipgm1", enabled: true });
  assert.strictEqual(ftbOn.success, true);
  assert.strictEqual(ftbOn.ftb, true);

  const ftbOff = await toggleFtb({ pipelineId: "pipgm1", enabled: false });
  assert.strictEqual(ftbOff.success, true);
  assert.strictEqual(ftbOff.ftb, false);
});

test("gateway-api executes Step 3 (setProjectorPicMute)", async () => {
  const muteOn = await setProjectorPicMute({ muted: true });
  assert.strictEqual(muteOn.success, true);
  assert.strictEqual(muteOn.muted, true);

  const muteOff = await setProjectorPicMute({ muted: false });
  assert.strictEqual(muteOff.success, true);
  assert.strictEqual(muteOff.muted, false);
});

test("gateway-api getGatewayStatus returns status object", async () => {
  const status = await getGatewayStatus("pipgm1");
  assert.strictEqual(status.online, true);
  assert.strictEqual(status.pipelineId, "pipgm1");
  assert.strictEqual(status.matrixRoute, "both_projectors");
  assert.strictEqual(status.ftb, false);
  assert.strictEqual(status.picMute, false);
});
