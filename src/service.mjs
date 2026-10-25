// Canva items and the hand-off of their pages to piprogram.
// A pushed design becomes one piprogram media item per page (images, or videos for mp4 exports).
// Embed-only items (a live Canva iframe) need piprogram support that does not exist yet, so they are refused.
import { designIdFrom, isAllowedAssetUrl, mediaFormat } from "./canva.mjs";
import { PiprogramError } from "./piprogram.mjs";

export const PIPELINE_IDS = ["PiPGM1", "PiPGM2", "PiPGM3"];
const CONTROL_ACTIONS = new Set(["next", "prev", "gotoPage", "ftb", "mute", "play", "pause", "stop", "restart"]);
const MAX_PAGES = 200;
const DOWNLOAD_TIMEOUT_MS = 60000;

export class PicanvaError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "PicanvaError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createPicanvaService({ config, piprogram, canvaConnect, fetchImpl = fetch }) {
  // In-memory on purpose: piprogram keeps the media it was handed. A restart forgets the Canva records only.
  const items = new Map();
  let counter = 0;

  function publicItem(record) {
    return structuredClone(record);
  }

  function pipelineOf(value) {
    if (value === undefined) return "PiPGM1";
    if (!PIPELINE_IDS.includes(value)) {
      throw new PicanvaError(422, "INVALID_PIPELINE_ID", "targetPipelineId must be PiPGM1, PiPGM2 or PiPGM3");
    }
    return value;
  }

  function latestItemFor(designId) {
    let found;
    for (const record of items.values()) {
      if (designId && record.designId !== designId) continue;
      found = record;
    }
    return found;
  }

  async function downloadAsset(url, maxBytes) {
    if (!isAllowedAssetUrl(url, config.assetHosts)) {
      throw new PicanvaError(422, "ASSET_HOST_NOT_ALLOWED", "Export URLs must be https URLs on an allowed Canva host");
    }
    let response;
    try {
      // Redirects are refused: an allowed host must not bounce the download somewhere else.
      response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new PicanvaError(502, "ASSET_DOWNLOAD_FAILED", `Export download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new PicanvaError(502, "ASSET_DOWNLOAD_FAILED", `Export download answered HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new PicanvaError(413, "ASSET_TOO_LARGE", `Export is larger than ${maxBytes} bytes`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new PicanvaError(413, "ASSET_TOO_LARGE", `Export is larger than ${maxBytes} bytes`);
    return data;
  }

  /** Pushes a design: exports it (autoExport) or takes exportUrls, then hands every page to piprogram. */
  async function push(input, { pushedFromCanvaApp }) {
    const designId = designIdFrom(input.designId ?? input.viewUrl);
    if (!designId) {
      throw new PicanvaError(422, "INVALID_CANVA_DESIGN", "A valid Canva designId or design URL is required");
    }
    const exportFormat = input.exportFormat === "mp4" ? "mp4" : "png";
    const format = mediaFormat(exportFormat);
    const targetPipelineId = pipelineOf(input.targetPipelineId);
    const cueImmediately = input.cueImmediately ?? true;
    const title = input.title?.trim() || `Canva ${designId}`;

    let urls = (input.exportUrls ?? []).filter((u) => typeof u === "string" && u.trim().length > 0).map((u) => u.trim());
    if (urls.length === 0 && input.autoExport) {
      if (!canvaConnect) {
        throw new PicanvaError(422, "CANVA_CONNECT_NOT_CONFIGURED", "autoExport needs CANVA_ACCESS_TOKEN; send exportUrls instead");
      }
      try {
        urls = await canvaConnect.exportDesign({
          designId,
          exportFormat,
          orientation: input.orientation === "portrait" ? "portrait" : "landscape",
          pollMs: config.exportPollMs,
          timeoutMs: config.exportTimeoutMs
        });
      } catch (err) {
        throw new PicanvaError(502, "CANVA_EXPORT_FAILED", err instanceof Error ? err.message : "Canva export failed");
      }
    }
    if (urls.length === 0) {
      throw new PicanvaError(
        422,
        "NO_EXPORTED_PAGES",
        "Nothing to hand to piprogram: send exportUrls or autoExport. Embed-only Canva items are not supported yet."
      );
    }
    if (urls.length > MAX_PAGES) throw new PicanvaError(422, "TOO_MANY_PAGES", `At most ${MAX_PAGES} pages per design`);

    counter += 1;
    const record = {
      id: `canva-${Date.now().toString(36)}-${counter}`,
      designId,
      title,
      format: exportFormat,
      targetPipelineId,
      pushedFromCanvaApp,
      status: "handing_off",
      error: null,
      pages: [],
      createdAt: new Date().toISOString()
    };
    items.set(record.id, record);

    try {
      for (let index = 0; index < urls.length; index += 1) {
        const pageNumber = index + 1;
        const data = await downloadAsset(urls[index], config.maxAssetBytes);
        const created = await piprogram.createMediaItem({
          kind: format.kind,
          title: `${title} · ${pageNumber}`,
          filename: `${designId}-${pageNumber}.${format.ext}`,
          mimeType: format.mimeType,
          dataBase64: data.toString("base64"),
          fit: "contain",
          targetPipelineId,
          cueImmediately: cueImmediately && index === 0
        });
        record.pages.push({ pageNumber, piprogramItemId: created.id });
      }
      record.status = "handed_off";
    } catch (err) {
      record.status = "partial";
      record.error = err instanceof Error ? err.message : String(err);
      const status = err instanceof PiprogramError ? err.status : err instanceof PicanvaError ? err.status : 502;
      const code = err instanceof PicanvaError ? err.code : "HANDOFF_FAILED";
      throw new PicanvaError(status, code, record.error, { item: publicItem(record) });
    }
    return publicItem(record);
  }

  /** Transport and page control, forwarded to piprogram. */
  async function control(input) {
    if (!CONTROL_ACTIONS.has(input.action)) {
      throw new PicanvaError(422, "INVALID_CANVA_CONTROL_ACTION", `action must be one of: ${[...CONTROL_ACTIONS].join(", ")}`);
    }
    let pipelines;
    if (input.targetPipelineId === "all") {
      pipelines = PIPELINE_IDS;
    } else if (input.targetPipelineId !== undefined) {
      pipelines = [pipelineOf(input.targetPipelineId)];
    } else {
      const designId = input.designId ? designIdFrom(input.designId) : undefined;
      const record = latestItemFor(designId);
      pipelines = [record?.targetPipelineId ?? "PiPGM1"];
    }

    let call;
    switch (input.action) {
      case "gotoPage": {
        const designId = input.designId ? designIdFrom(input.designId) : undefined;
        const record = latestItemFor(designId);
        const page = record?.pages[(input.pageNumber ?? 1) - 1];
        if (!page) throw new PicanvaError(422, "PAGE_NOT_FOUND", "No handed-off page with that number for this design");
        call = (pipelineId) => piprogram.control(pipelineId, { action: "gotoItem", itemId: page.piprogramItemId });
        break;
      }
      case "next":
      case "prev":
        call = (pipelineId) => piprogram.control(pipelineId, { action: input.action, advanceItemOnEnd: true });
        break;
      case "play":
      case "pause":
      case "stop":
      case "restart":
        call = (pipelineId) => piprogram.control(pipelineId, { action: input.action });
        break;
      case "ftb":
        call = (pipelineId) =>
          piprogram.ftb(pipelineId, {
            ...(input.fadeToBlack !== undefined ? { fadeToBlack: input.fadeToBlack } : {}),
            toggle: input.toggle ?? input.fadeToBlack === undefined
          });
        break;
      case "mute":
        call = (pipelineId) =>
          piprogram.audio(pipelineId, {
            ...(input.audioEnabled !== undefined ? { audioEnabled: input.audioEnabled } : {}),
            toggle: input.toggle ?? input.audioEnabled === undefined
          });
        break;
    }

    const results = [];
    for (const pipelineId of pipelines) {
      results.push(await call(pipelineId));
    }
    return { success: true, action: input.action, pipelines: results };
  }

  return {
    push,
    control,
    listItems: () => [...items.values()].map(publicItem),
    getItem: (id) => (items.has(id) ? publicItem(items.get(id)) : undefined)
  };
}
