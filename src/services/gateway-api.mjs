import { CONFIG } from "../config.mjs";

/**
 * Custom error class for Pi Gateway API errors.
 */
export class GatewayError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.details = details;
  }
}

let customFetchImpl = null;

export function setFetchImpl(fn) {
  customFetchImpl = fn;
}

export function resetFetchImpl() {
  customFetchImpl = null;
}

/**
 * Standard headers for Pi Gateway requests.
 */
function getHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (CONFIG.gatewayApiKey) {
    headers["Authorization"] = `Bearer ${CONFIG.gatewayApiKey}`;
    headers["X-Api-Key"] = CONFIG.gatewayApiKey;
  }
  return headers;
}

/**
 * Helper to execute a fetch request with timeout.
 */
async function apiRequest(path, options = {}) {
  const url = `${CONFIG.gatewayUrl}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 10000);

  try {
    const fetchFn = customFetchImpl || fetch;
    const response = await fetchFn(url, {
      ...options,
      headers: {
        ...getHeaders(),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errData = null;
      try {
        errData = await response.json();
      } catch {
        // ignore parse error
      }
      const message = errData?.message || errData?.error || `HTTP ${response.status} from Gateway`;
      throw new GatewayError(message, response.status, errData);
    }

    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new GatewayError(`Request to Gateway timed out (${url})`, 504);
    }
    if (err instanceof GatewayError) throw err;
    throw new GatewayError(`Failed to connect to Pi Gateway at ${CONFIG.gatewayUrl}: ${err.message}`, 0);
  }
}

// In-memory simulation state for offline dev testing
const devSimulationState = {
  currentPresentation: null,
  pipelineId: "pipgm1",
  matrixRoute: "both_projectors",
  currentSlide: 1,
  totalSlides: 1,
  ftb: false,
  picMute: false,
};

/**
 * Step 1: Push exported slides to Pi Gateway (staged in Pi Program storage).
 */
export async function pushContent({ title, pages }) {
  try {
    return await apiRequest("/api/v1/canva/push", {
      method: "POST",
      body: JSON.stringify({
        title,
        pages: pages.map((p) => ({
          pageNumber: p.pageNumber,
          url: p.url,
          name: p.name,
        })),
      }),
    });
  } catch (err) {
    if (CONFIG.isDev) {
      console.warn("[picanva] Gateway unreachable in dev mode - using local simulation:", err.message);
      const presentationId = `pres_${Date.now()}`;
      devSimulationState.currentPresentation = {
        presentationId,
        title,
        pages,
        pageCount: pages.length,
      };
      devSimulationState.totalSlides = pages.length;
      devSimulationState.currentSlide = 1;
      return {
        success: true,
        presentationId,
        title,
        pageCount: pages.length,
        isSimulated: true,
      };
    }
    throw err;
  }
}

/**
 * Step 2: Configure Presentation Pipeline and route to displays.
 */
export async function setupPresentation({ presentationId, pipelineId, matrixRoute, unblankProjectors, cueSlide = 1 }) {
  try {
    return await apiRequest("/api/v1/canva/setup", {
      method: "POST",
      body: JSON.stringify({
        presentationId,
        pipelineId,
        matrixRoute,
        unblankProjectors,
        cueSlide,
      }),
    });
  } catch (err) {
    if (CONFIG.isDev) {
      console.warn("[picanva] Gateway unreachable in dev mode - simulating setup:", err.message);
      devSimulationState.pipelineId = pipelineId;
      devSimulationState.matrixRoute = matrixRoute;
      devSimulationState.currentSlide = cueSlide;
      if (unblankProjectors) {
        devSimulationState.picMute = false;
      }
      return {
        success: true,
        pipelineId,
        matrixRoute,
        picMute: devSimulationState.picMute,
        currentSlide: cueSlide,
        isSimulated: true,
      };
    }
    throw err;
  }
}

/**
 * Step 3: Slide Navigation (next, prev, gotoPage).
 */
export async function controlSlide({ pipelineId, action, page }) {
  try {
    return await apiRequest("/api/v1/canva/control", {
      method: "POST",
      body: JSON.stringify({
        pipelineId,
        action,
        page,
      }),
    });
  } catch (err) {
    if (CONFIG.isDev) {
      console.warn("[picanva] Simulating slide control:", action, page);
      if (action === "next") {
        devSimulationState.currentSlide = Math.min(devSimulationState.totalSlides, devSimulationState.currentSlide + 1);
      } else if (action === "prev") {
        devSimulationState.currentSlide = Math.max(1, devSimulationState.currentSlide - 1);
      } else if (action === "gotoPage" && typeof page === "number") {
        devSimulationState.currentSlide = Math.max(1, Math.min(devSimulationState.totalSlides, page));
      }
      return {
        success: true,
        currentPage: devSimulationState.currentSlide,
        isSimulated: true,
      };
    }
    throw err;
  }
}

/**
 * Step 3: Fade to Black (FTB) on Pi Program.
 */
export async function toggleFtb({ pipelineId, enabled }) {
  try {
    return await apiRequest("/api/v1/canva/control", {
      method: "POST",
      body: JSON.stringify({
        pipelineId,
        action: "ftb",
        enabled,
      }),
    });
  } catch (err) {
    if (CONFIG.isDev) {
      devSimulationState.ftb = enabled;
      return { success: true, ftb: enabled, isSimulated: true };
    }
    throw err;
  }
}

/**
 * Step 3: Hardware Projector Pic Mute (shutter beam blanking via /canva/control).
 */
export async function setProjectorPicMute({ muted, pipelineId }) {
  try {
    return await apiRequest("/api/v1/canva/control", {
      method: "POST",
      body: JSON.stringify({
        pipelineId,
        action: "picMute",
        muted,
      }),
    });
  } catch (err) {
    if (CONFIG.isDev) {
      devSimulationState.picMute = muted;
      return { success: true, muted, isSimulated: true };
    }
    throw err;
  }
}

/**
 * Push transparent graphic still to ATEM Media Pool with Flying Key.
 */
export async function pushCanvaGraphic({
  title,
  image,
  imageUrl,
  movement = "fly-left",
  autoHideMs = 7000,
  keyer = "usk",
  slot = 7,
}) {
  try {
    return await apiRequest("/api/v1/graphics/canva/push", {
      method: "POST",
      body: JSON.stringify({
        title,
        image,
        imageUrl,
        movement,
        autoHideMs,
        keyer,
        slot,
      }),
    });
  } catch (err) {
    if (CONFIG.isDev) {
      console.warn("[picanva] Gateway unreachable in dev mode - simulating graphics push:", err.message);
      return {
        ok: true,
        isSimulated: true,
        title: title || "Canva Graphic",
        slot,
        mediaPlayer: 1,
        movement,
        keyer,
        autoHideMs,
      };
    }
    throw err;
  }
}

/**
 * Takes active ATEM graphic keyer (USK or DSK) off air.
 */
export async function setCanvaGraphicOffAir({ keyer = "usk", index = 1 } = {}) {
  try {
    return await apiRequest("/api/v1/graphics/canva/off-air", {
      method: "POST",
      body: JSON.stringify({ keyer, index }),
    });
  } catch (err) {
    if (CONFIG.isDev) {
      console.warn("[picanva] Simulating graphic off-air:", err.message);
      return { ok: true, isSimulated: true, offAir: true, keyer, index };
    }
    throw err;
  }
}

/**
 * Health check & status polling.
 */
export async function getGatewayStatus(pipelineId = "pipgm1") {
  try {
    return await apiRequest(`/api/v1/canva/status?pipelineId=${pipelineId}`, { timeoutMs: 3000 });
  } catch (err) {
    if (CONFIG.isDev) {
      return {
        online: false,
        isSimulated: true,
        pipelineId: devSimulationState.pipelineId,
        matrixRoute: devSimulationState.matrixRoute,
        currentSlide: devSimulationState.currentSlide,
        totalSlides: devSimulationState.totalSlides,
        ftb: devSimulationState.ftb,
        picMute: devSimulationState.picMute,
      };
    }
    throw err;
  }
}
