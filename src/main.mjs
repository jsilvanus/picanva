import { CONFIG } from "./config.mjs";
import { exportDesignPages, isRunningInCanva } from "./services/canva-sdk.mjs";
import {
  pushContent,
  setupPresentation,
  controlSlide,
  toggleFtb,
  setProjectorPicMute,
  getGatewayStatus,
  pushCanvaGraphic,
  setCanvaGraphicOffAir,
} from "./services/gateway-api.mjs";

// App reactive state
const state = {
  appMode: "slides", // "slides" | "graphics"
  currentStep: 1, // 1: Push, 2: Setup, 3: Live Control
  isExporting: false,
  isPushing: false,
  isSettingUp: false,
  isControlling: false,
  gatewayStatus: "checking", // online | simulated | offline | checking

  // Broadcast Graphics (ATEM Flying Key & Live Driving)
  graphics: {
    isPushing: false,
    movement: "fly-left", // fly-left | fly-right | fly-bottom | fly-top | zoom | dissolve | cut
    autoHideMs: 7000,
    slot: 7,
    mediaPlayer: 1,
    keyer: "usk",
    onAir: false,
    pages: [],
    cuedIndex: 1,
    onAirIndex: null,
    autoHideRemainingSeconds: null,
  },

  // Export & Staging Progress
  progress: {
    visible: false,
    percent: 0,
    label: "",
  },

  // Staged presentation from Step 1
  staged: {
    presentationId: null,
    title: "",
    pageCount: 0,
    pages: [],
  },

  // Presentation setup configuration for Step 2
  setup: {
    pipelineId: "pipgm1",
    matrixRoute: "both_projectors",
    unblankProjectors: true,
    cueSlide: 1,
  },

  // Live presentation controls for Step 3
  live: {
    pipelineId: "pipgm1",
    matrixRoute: "both_projectors",
    currentSlide: 1,
    totalSlides: 1,
    ftb: false,
    picMute: false,
    pages: [],
  },

  toast: null,
};

let toastTimeout = null;

function showToast(message, type = "info", durationMs = 4000) {
  if (toastTimeout) clearTimeout(toastTimeout);
  state.toast = { message, type };
  render();
  toastTimeout = setTimeout(() => {
    state.toast = null;
    render();
  }, durationMs);
}

function setProgress(percent, label) {
  state.progress.visible = true;
  state.progress.percent = Math.min(100, Math.max(0, Math.round(percent)));
  state.progress.label = label || "Processing...";
  render();
}

function clearProgress() {
  state.progress.visible = false;
  state.progress.percent = 0;
  state.progress.label = "";
  render();
}

function renderProgressBar() {
  if (!state.progress.visible) return "";
  return `
    <div class="progress-container">
      <div class="progress-header">
        <span class="progress-label">${state.progress.label}</span>
        <span class="progress-percent">${state.progress.percent}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${state.progress.percent}%;"></div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// Action Handlers
// -------------------------------------------------------------

/**
 * Step 1: Push Content
 * Runs Canva SDK export, then uploads pages to Pi Gateway storage.
 */
async function handlePushContent() {
  if (state.isExporting || state.isPushing) return;

  try {
    state.isExporting = true;
    setProgress(15, "Exporting slides from Canva...");
    render();

    const exportResult = await exportDesignPages();
    state.isExporting = false;

    if (exportResult.status === "aborted") {
      clearProgress();
      showToast("Export was cancelled.", "info");
      render();
      return;
    }

    if (!exportResult.exportBlobs || exportResult.exportBlobs.length === 0) {
      clearProgress();
      showToast("No pages were exported from Canva.", "error");
      render();
      return;
    }

    state.isPushing = true;
    setProgress(55, `Uploading ${exportResult.exportBlobs.length} slides to Church Gateway...`);
    render();

    const pushResult = await pushContent({
      title: exportResult.title || "Canva Slides",
      pages: exportResult.exportBlobs,
    });

    setProgress(95, "Staging media in Pi Program storage...");
    state.isPushing = false;
    state.staged = {
      presentationId: pushResult.presentationId || `pres_${Date.now()}`,
      title: exportResult.title || "Canva Presentation",
      pageCount: exportResult.exportBlobs.length,
      pages: exportResult.exportBlobs,
    };

    // Auto advance to Step 2
    state.currentStep = 2;
    clearProgress();
    showToast(`Pushed ${exportResult.exportBlobs.length} slides to church storage!`, "success");
    render();
  } catch (err) {
    clearProgress();
    state.isExporting = false;
    state.isPushing = false;
    console.error("[picanva] Push failed:", err);
    showToast(err.message || "Failed to push slides.", "error");
    render();
  }
}

/**
 * Step 2: Presentation Setup
 * Configures the live presentation pipeline and routes video on Pi Matrix.
 */
async function handleApplySetup() {
  if (state.isSettingUp) return;

  try {
    state.isSettingUp = true;
    render();

    const result = await setupPresentation({
      presentationId: state.staged.presentationId,
      pipelineId: state.setup.pipelineId,
      matrixRoute: state.setup.matrixRoute,
      unblankProjectors: state.setup.unblankProjectors,
      cueSlide: state.setup.cueSlide,
    });

    state.isSettingUp = false;

    // Initialize Step 3 Live state
    state.live = {
      pipelineId: state.setup.pipelineId,
      matrixRoute: state.setup.matrixRoute,
      currentSlide: state.setup.cueSlide || 1,
      totalSlides: state.staged.pageCount || 1,
      ftb: false,
      picMute: result.picMute ?? false,
      pages: state.staged.pages,
    };

    state.currentStep = 3;
    showToast("Presentation armed & routed live to displays!", "success");
    render();
  } catch (err) {
    state.isSettingUp = false;
    console.error("[picanva] Setup failed:", err);
    showToast(err.message || "Failed to configure presentation pipeline.", "error");
    render();
  }
}

/**
 * Step 3: Live Navigation Controls
 */
async function handleSlideNav(action, targetPage = null) {
  if (state.isControlling) return;

  let nextSlide = state.live.currentSlide;
  if (action === "next") {
    if (state.live.currentSlide >= state.live.totalSlides) return;
    nextSlide = state.live.currentSlide + 1;
  } else if (action === "prev") {
    if (state.live.currentSlide <= 1) return;
    nextSlide = state.live.currentSlide - 1;
  } else if (action === "gotoPage" && targetPage) {
    nextSlide = Math.max(1, Math.min(state.live.totalSlides, targetPage));
  }

  // Optimistic UI update
  state.live.currentSlide = nextSlide;
  render();

  try {
    state.isControlling = true;
    const res = await controlSlide({
      pipelineId: state.live.pipelineId,
      action,
      page: action === "gotoPage" ? nextSlide : undefined,
    });
    state.isControlling = false;
    if (res && typeof res.currentPage === "number") {
      state.live.currentSlide = res.currentPage;
    }
    render();
  } catch (err) {
    state.isControlling = false;
    console.error("[picanva] Slide control failed:", err);
    showToast(err.message || "Failed to change slide.", "error");
    render();
  }
}

/**
 * Step 3: Fade to Black (FTB) Toggle
 */
async function handleToggleFtb() {
  const newFtb = !state.live.ftb;
  state.live.ftb = newFtb;
  render();

  try {
    await toggleFtb({
      pipelineId: state.live.pipelineId,
      enabled: newFtb,
    });
    showToast(newFtb ? "Fade to Black (FTB) ACTIVE" : "Fade to Black OFF", newFtb ? "info" : "success", 2000);
  } catch (err) {
    state.live.ftb = !newFtb; // revert
    console.error("[picanva] FTB failed:", err);
    showToast(err.message || "Failed to toggle FTB.", "error");
  }
  render();
}

/**
 * Step 3: Hardware Projector Pic Mute Toggle
 */
async function handleTogglePicMute() {
  const newMute = !state.live.picMute;
  state.live.picMute = newMute;
  render();

  try {
    await setProjectorPicMute({ muted: newMute, pipelineId: state.live.pipelineId });
    showToast(newMute ? "Projector Pic Mute ON (Beams Blanked)" : "Projector Pic Mute OFF (Beams Live)", newMute ? "info" : "success", 2500);
  } catch (err) {
    state.live.picMute = !newMute; // revert
    console.error("[picanva] Pic Mute failed:", err);
    showToast(err.message || "Failed to toggle projector mute.", "error");
  }
  render();
}

// Global Keyboard Navigation
window.addEventListener("keydown", (e) => {
  if (e.target && ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;

  // Stream Graphics Mode shortcuts
  if (state.appMode === "graphics") {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (state.graphics.onAir) {
        handleGraphicOffAir();
      } else {
        handleFlyCuedGraphic();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleGraphicOffAir();
    } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      handleGraphicNav("next");
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      handleGraphicNav("prev");
    }
    return;
  }

  // Only handle shortcuts when on Step 3 for Slide Presentation
  if (state.currentStep !== 3) return;

  if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
    e.preventDefault();
    handleSlideNav("next");
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    e.preventDefault();
    handleSlideNav("prev");
  } else if (e.key === "b" || e.key === "B") {
    e.preventDefault();
    handleToggleFtb();
  } else if (e.key === "m" || e.key === "M") {
    e.preventDefault();
    handleTogglePicMute();
  }
});

let graphicCountdownInterval = null;

// Broadcast Graphic Actions (ATEM Flying Key & Live Driving)
async function handleExportGraphicsDeck() {
  if (state.graphics.isPushing) return;

  try {
    state.graphics.isPushing = true;
    setProgress(20, "Exporting transparent graphics deck from Canva...");
    render();

    const exportResult = await exportDesignPages();
    if (exportResult.status === "aborted") {
      clearProgress();
      state.graphics.isPushing = false;
      showToast("Graphic export was cancelled.", "info");
      render();
      return;
    }

    if (!exportResult.exportBlobs || exportResult.exportBlobs.length === 0) {
      clearProgress();
      state.graphics.isPushing = false;
      showToast("No pages were exported from Canva.", "error");
      render();
      return;
    }

    setProgress(70, `Staged ${exportResult.exportBlobs.length} graphics for ATEM live driving...`);
    state.graphics.pages = exportResult.exportBlobs;
    state.graphics.cuedIndex = 1;

    setProgress(100, "Graphics deck ready for on-air driving!");
    setTimeout(() => {
      clearProgress();
      state.graphics.isPushing = false;
      showToast(`Loaded ${exportResult.exportBlobs.length} graphics into live driving deck!`, "success");
      render();
    }, 200);
  } catch (err) {
    clearProgress();
    state.graphics.isPushing = false;
    showToast(`Failed to export graphics: ${err.message}`, "error");
    render();
  }
}

async function handleFlyCuedGraphic(targetIndex) {
  const index = targetIndex || state.graphics.cuedIndex;
  const page = state.graphics.pages && state.graphics.pages[index - 1];
  if (!page) {
    showToast("No graphic selected to fly.", "error");
    return;
  }

  state.graphics.cuedIndex = index;
  state.graphics.isPushing = true;
  setProgress(50, `Flown to ATEM: ${page.name || `Graphic ${index}`}...`);
  render();

  try {
    const title = page.name || `Graphic ${index}`;
    await pushCanvaGraphic({
      title,
      imageUrl: page.url,
      movement: state.graphics.movement,
      autoHideMs: state.graphics.autoHideMs,
      slot: state.graphics.slot,
      mediaPlayer: state.graphics.mediaPlayer,
      keyer: state.graphics.keyer,
    });

    state.graphics.isPushing = false;
    state.graphics.onAir = true;
    state.graphics.onAirIndex = index;
    clearProgress();
    showToast(`ON AIR: ${title} (${state.graphics.movement})`, "success");

    if (graphicCountdownInterval) {
      clearInterval(graphicCountdownInterval);
      graphicCountdownInterval = null;
    }

    if (state.graphics.autoHideMs > 0) {
      let remaining = Math.round(state.graphics.autoHideMs / 1000);
      state.graphics.autoHideRemainingSeconds = remaining;
      render();

      graphicCountdownInterval = setInterval(() => {
        remaining -= 1;
        state.graphics.autoHideRemainingSeconds = remaining;
        if (remaining <= 0) {
          clearInterval(graphicCountdownInterval);
          graphicCountdownInterval = null;
          state.graphics.onAir = false;
          state.graphics.onAirIndex = null;
          state.graphics.autoHideRemainingSeconds = null;
          render();
        } else {
          render();
        }
      }, 1000);
    } else {
      state.graphics.autoHideRemainingSeconds = null;
      render();
    }
  } catch (err) {
    clearProgress();
    state.graphics.isPushing = false;
    showToast(`Failed to fly graphic: ${err.message}`, "error");
    render();
  }
}

async function handleGraphicOffAir() {
  if (graphicCountdownInterval) {
    clearInterval(graphicCountdownInterval);
    graphicCountdownInterval = null;
  }
  try {
    await setCanvaGraphicOffAir({ keyer: state.graphics.keyer, index: 1 });
    state.graphics.onAir = false;
    state.graphics.onAirIndex = null;
    state.graphics.autoHideRemainingSeconds = null;
    showToast("Graphic taken off air.", "info");
    render();
  } catch (err) {
    showToast(`Failed to take off air: ${err.message}`, "error");
  }
}

function handleGraphicNav(direction) {
  if (!state.graphics.pages || state.graphics.pages.length === 0) return;
  const total = state.graphics.pages.length;
  if (direction === "next") {
    state.graphics.cuedIndex = state.graphics.cuedIndex >= total ? 1 : state.graphics.cuedIndex + 1;
  } else if (direction === "prev") {
    state.graphics.cuedIndex = state.graphics.cuedIndex <= 1 ? total : state.graphics.cuedIndex - 1;
  }
  render();
}

// Periodic Gateway Health Check
async function checkGatewayHealth() {
  try {
    const res = await getGatewayStatus(state.live.pipelineId);
    state.gatewayStatus = res.isSimulated ? "simulated" : "online";
  } catch {
    state.gatewayStatus = "offline";
  }
  render();
}
setInterval(checkGatewayHealth, 15000);
checkGatewayHealth();

// -------------------------------------------------------------
// HTML Rendering Functions
// -------------------------------------------------------------

function renderHeader() {
  const dotClass = state.gatewayStatus === "online" ? "online" : state.gatewayStatus === "simulated" ? "simulated" : "offline";
  const statusText = state.gatewayStatus === "online" ? "Gateway Connected" : state.gatewayStatus === "simulated" ? "Simulated Dev" : "Gateway Offline";

  return `
    <header class="app-header">
      <div class="header-top">
        <div class="brand-title">
          <span class="church-badge">Church</span>
          <span>${CONFIG.appName}</span>
        </div>
        <div class="status-pill" title="Gateway: ${CONFIG.gatewayUrl}">
          <span class="status-dot ${dotClass}"></span>
          <span>${statusText}</span>
        </div>
      </div>
      <div class="target-info">
        Target: <strong>${CONFIG.gatewayUrl}</strong>
      </div>
      <div class="mode-switcher" style="margin-top: 4px;">
        <button class="mode-btn ${state.appMode === "slides" ? "active" : ""}" data-mode="slides">
          📽 Slide Presentation
        </button>
        <button class="mode-btn ${state.appMode === "graphics" ? "active" : ""}" data-mode="graphics">
          🎬 ATEM Graphic (Fly Key)
        </button>
      </div>
    </header>
  `;
}

function renderGraphicsView() {
  const isBusy = state.graphics.isPushing;
  const onAir = state.graphics.onAir;
  const pages = state.graphics.pages || [];
  const total = pages.length;
  const cuedIndex = Math.max(1, Math.min(total || 1, state.graphics.cuedIndex || 1));
  const cuedGraphic = pages[cuedIndex - 1];

  if (total === 0) {
    return `
      <section class="view-card">
        <div class="card-title">
          <span>🎬 Stream Graphics (Fly Key)</span>
          <span class="status-pill offline" style="font-weight: 700;">● OFF AIR</span>
        </div>
        <div class="card-subtitle">
          Export transparent overlays, scripture straps, lower-thirds, or song titles from Canva and drive them live to ATEM Media Player with smooth DVE Flying Key motion.
        </div>

        <button class="btn-primary" id="btn-export-graphics" style="width: 100%; margin: 14px 0 8px;" ${isBusy ? "disabled" : ""}>
          ${isBusy ? `<span class="spinner"></span> Loading Deck from Canva...` : `📥 Load Graphics Deck from Canva`}
        </button>

        <!-- Movement Selection -->
        <div class="form-group" style="margin-top: 10px;">
          <label class="form-label">Default Movement (ATEM Flying Key)</label>
          <select class="select-input" id="select-graphic-movement">
            <option value="fly-left" ${state.graphics.movement === "fly-left" ? "selected" : ""}>🚀 Fly in from Left (Smooth Slide)</option>
            <option value="fly-right" ${state.graphics.movement === "fly-right" ? "selected" : ""}>🚀 Fly in from Right</option>
            <option value="fly-bottom" ${state.graphics.movement === "fly-bottom" ? "selected" : ""}>⬆ Fly in from Bottom (Pop-Up)</option>
            <option value="fly-top" ${state.graphics.movement === "fly-top" ? "selected" : ""}>⬇ Fly in from Top (Drop-Down)</option>
            <option value="zoom" ${state.graphics.movement === "zoom" ? "selected" : ""}>🔍 Zoom / Grow from Center</option>
            <option value="dissolve" ${state.graphics.movement === "dissolve" ? "selected" : ""}>✨ Dissolve / Mix Fade</option>
            <option value="cut" ${state.graphics.movement === "cut" ? "selected" : ""}>⚡ Cut (Instant)</option>
          </select>
        </div>

        <!-- Auto-Hide Duration -->
        <div class="form-group">
          <label class="form-label">On-Air Duration (Auto-Hide)</label>
          <select class="select-input" id="select-graphic-autohide">
            <option value="0" ${state.graphics.autoHideMs === 0 ? "selected" : ""}>Manual (Hold until dismissed)</option>
            <option value="5000" ${state.graphics.autoHideMs === 5000 ? "selected" : ""}>5 seconds</option>
            <option value="7000" ${state.graphics.autoHideMs === 7000 ? "selected" : ""}>7 seconds (Standard Lower Third)</option>
            <option value="10000" ${state.graphics.autoHideMs === 10000 ? "selected" : ""}>10 seconds</option>
            <option value="15000" ${state.graphics.autoHideMs === 15000 ? "selected" : ""}>15 seconds</option>
          </select>
        </div>

        ${
          !isRunningInCanva()
            ? `<div style="font-size: 11px; color: var(--accent-amber); text-align: center; margin-top: 8px;">
                Running in Dev Mock Mode: loads simulated graphics deck.
              </div>`
            : ""
        }
      </section>
    `;
  }

  const isCurrentOnAir = onAir && state.graphics.onAirIndex === cuedIndex;

  return `
    <section class="view-card">
      <div class="card-title">
        <span>🎬 Stream Graphics Deck</span>
        <span class="status-pill ${onAir ? "online" : "offline"}" style="font-weight: 700;">
          ${onAir ? `● ON AIR ${state.graphics.autoHideRemainingSeconds ? `(${state.graphics.autoHideRemainingSeconds}s)` : ""}` : "● OFF AIR"}
        </span>
      </div>

      <!-- Live Driving Cued Graphic Box -->
      <div class="graphics-deck">
        <div class="graphic-cued-box ${isCurrentOnAir ? "on-air" : ""}">
          <div class="on-air-tag ${isCurrentOnAir ? "live" : "cued"}">
            ${isCurrentOnAir ? "● LIVE ON AIR" : "CUED"}
          </div>
          <div class="graphic-preview-wrap">
            <img class="graphic-preview-img" src="${cuedGraphic ? cuedGraphic.url : ""}" alt="${cuedGraphic ? cuedGraphic.name : "Graphic"}" />
          </div>
          <div class="graphic-title-label">
            ${cuedGraphic ? cuedGraphic.name || `Graphic ${cuedIndex}` : `Graphic ${cuedIndex}`}
          </div>
          <div class="graphic-hotkey-bar">
            <span>[Space / Enter] Fly</span>
            <span>•</span>
            <span>[Esc] Off Air</span>
            <span>•</span>
            <span>[↑ / ↓] Cue</span>
          </div>
        </div>

        <!-- Big Navigation & Fly Controls -->
        <div class="nav-buttons-row">
          <button class="btn-nav btn-nav-prev" id="btn-prev-graphic">
            <span>◀ PREV</span>
            <span class="nav-key-hint">[Up / Left]</span>
          </button>
          <button class="btn-nav btn-nav-next" id="btn-next-graphic">
            <span>NEXT ▶</span>
            <span class="nav-key-hint">[Down / Right]</span>
          </button>
        </div>

        <!-- Fly Drive Button -->
        <button class="btn-primary" id="btn-fly-toggle" style="background-color: ${onAir ? "var(--accent-red)" : "var(--accent-blue)"}; width: 100%; font-size: 14px; font-weight: 800; padding: 12px; letter-spacing: 0.5px;" ${isBusy ? "disabled" : ""}>
          ${isBusy ? `<span class="spinner"></span> Flying to ATEM...` : onAir ? "⏹ TAKE OFF AIR [Space / Esc]" : `🚀 FLY ON AIR (${state.graphics.movement.toUpperCase()}) [Space]`}
        </button>

        <!-- Graphic Thumbnails Drawer -->
        <div class="form-label" style="margin-top: 4px;">Jump / Cue Graphic (${cuedIndex} of ${total})</div>
        <div class="thumbnails-strip">
          ${pages
            .map(
              (p, idx) => `
            <div class="thumb-card ${idx + 1 === cuedIndex ? "active" : ""}" data-cue-graphic="${idx + 1}" title="${p.name || `Graphic ${idx + 1}`}">
              <img src="${p.url}" alt="${p.name || `Graphic ${idx + 1}`}" />
              <span class="thumb-number">${idx + 1}</span>
            </div>
          `
            )
            .join("")}
        </div>

        <!-- Flying Key Motion & Duration Settings -->
        <div style="display: flex; gap: 8px; margin-top: 4px;">
          <div style="flex: 1;">
            <label class="form-label">Movement</label>
            <select class="select-input" id="select-graphic-movement">
              <option value="fly-left" ${state.graphics.movement === "fly-left" ? "selected" : ""}>🚀 Fly Left</option>
              <option value="fly-right" ${state.graphics.movement === "fly-right" ? "selected" : ""}>🚀 Fly Right</option>
              <option value="fly-bottom" ${state.graphics.movement === "fly-bottom" ? "selected" : ""}>⬆ Fly Bottom</option>
              <option value="fly-top" ${state.graphics.movement === "fly-top" ? "selected" : ""}>⬇ Fly Top</option>
              <option value="zoom" ${state.graphics.movement === "zoom" ? "selected" : ""}>🔍 Zoom</option>
              <option value="dissolve" ${state.graphics.movement === "dissolve" ? "selected" : ""}>✨ Dissolve</option>
              <option value="cut" ${state.graphics.movement === "cut" ? "selected" : ""}>⚡ Cut</option>
            </select>
          </div>
          <div style="flex: 1;">
            <label class="form-label">Auto-Hide</label>
            <select class="select-input" id="select-graphic-autohide">
              <option value="0" ${state.graphics.autoHideMs === 0 ? "selected" : ""}>Manual</option>
              <option value="5000" ${state.graphics.autoHideMs === 5000 ? "selected" : ""}>5s</option>
              <option value="7000" ${state.graphics.autoHideMs === 7000 ? "selected" : ""}>7s</option>
              <option value="10000" ${state.graphics.autoHideMs === 10000 ? "selected" : ""}>10s</option>
              <option value="15000" ${state.graphics.autoHideMs === 15000 ? "selected" : ""}>15s</option>
            </select>
          </div>
        </div>

        <!-- Destination Slot & Keyer -->
        <div style="display: flex; gap: 8px;">
          <div style="flex: 1;">
            <label class="form-label">Media Player</label>
            <select class="select-input" id="select-graphic-player">
              <option value="1" ${state.graphics.mediaPlayer === 1 ? "selected" : ""}>Media Player 1</option>
              <option value="2" ${state.graphics.mediaPlayer === 2 ? "selected" : ""}>Media Player 2</option>
            </select>
          </div>
          <div style="flex: 1;">
            <label class="form-label">ATEM Pool Slot</label>
            <select class="select-input" id="select-graphic-slot">
              <option value="7" ${state.graphics.slot === 7 ? "selected" : ""}>Slot 7</option>
              <option value="8" ${state.graphics.slot === 8 ? "selected" : ""}>Slot 8</option>
              <option value="9" ${state.graphics.slot === 9 ? "selected" : ""}>Slot 9</option>
              <option value="10" ${state.graphics.slot === 10 ? "selected" : ""}>Slot 10</option>
            </select>
          </div>
        </div>

        <div class="footer-actions" style="margin-top: 6px;">
          <button class="link-btn" id="btn-reexport-graphics">🔄 Re-export Graphics from Canva</button>
          <button class="link-btn" id="btn-graphic-offair" style="color: var(--accent-red);" ${!onAir ? "disabled" : ""}>⏹ Force Off Air</button>
        </div>
      </div>
    </section>
  `;
}

function renderStepTabs() {
  return `
    <nav class="step-nav" aria-label="Workflow Steps">
      <button class="step-tab ${state.currentStep === 1 ? "active" : ""}" data-step="1">
        <span>1. Push</span>
      </button>
      <button class="step-tab ${state.currentStep === 2 ? "active" : ""}" ${!state.staged.presentationId ? "disabled" : ""} data-step="2">
        <span>2. Setup</span>
      </button>
      <button class="step-tab ${state.currentStep === 3 ? "active" : ""}" ${state.live.totalSlides <= 1 && !state.staged.presentationId ? "disabled" : ""} data-step="3">
        <span>3. Live</span>
      </button>
    </nav>
  `;
}

function renderToast() {
  if (!state.toast) return "";
  return `
    <div class="toast-bar ${state.toast.type}">
      <span>${state.toast.message}</span>
    </div>
  `;
}

function renderStep1View() {
  const isBusy = state.isExporting || state.isPushing;
  const btnText = state.isExporting
    ? `<span class="spinner"></span> Exporting from Canva...`
    : state.isPushing
    ? `<span class="spinner"></span> Uploading to Pi Storage...`
    : `📤 Push Content to Church`;

  const previewsHtml =
    state.staged.pages && state.staged.pages.length > 0
      ? `
      <div class="export-meta">
        <div class="meta-row">
          <span class="meta-label">Title:</span>
          <span class="meta-value">${state.staged.title || "Untitled Presentation"}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Staged Slides:</span>
          <span class="meta-value">${state.staged.pageCount} pages</span>
        </div>
      </div>
      <div class="preview-grid">
        ${state.staged.pages
          .map(
            (p) => `
          <div class="preview-item">
            <img src="${p.url}" alt="Slide ${p.pageNumber}" />
            <span class="preview-badge">${p.pageNumber}</span>
          </div>
        `
          )
          .join("")}
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn-primary" id="btn-repush" style="flex: 1;" ${isBusy ? "disabled" : ""}>
          ${btnText}
        </button>
        <button class="btn-secondary" id="btn-goto-step2" style="flex: 1;">
          Proceed to Setup ➔
        </button>
      </div>
    `
      : `
      <div class="card-subtitle">
        Export slides from your active Canva design directly into Pi Program church storage. Pushing saves your content safely without changing live screens.
      </div>
      <button class="btn-primary" id="btn-push" ${isBusy ? "disabled" : ""}>
        ${btnText}
      </button>
      ${
        !isRunningInCanva()
          ? `<div style="font-size: 11px; color: var(--accent-amber); text-align: center; margin-top: 4px;">
              Running outside Canva sandbox: will use simulated design export.
            </div>`
          : ""
      }
    `;

  return `
    <section class="view-card">
      <div class="card-title">
        <span>Step 1: Push Content</span>
        <span style="font-size: 11px; color: var(--text-dim);">Stage Media</span>
      </div>
      ${previewsHtml}
    </section>
  `;
}

function renderStep2View() {
  const isBusy = state.isSettingUp;
  const isPipgm1 = state.setup.pipelineId === "pipgm1";

  return `
    <section class="view-card">
      <div class="card-title">
        <span>Step 2: Presentation Setup</span>
        <span style="font-size: 11px; color: var(--text-dim);">${state.staged.pageCount} slides ready</span>
      </div>
      <div class="card-subtitle">
        Configure which Pi Program pipeline will present this content, where to route it on the Pi Matrix, and projector shutter options.
      </div>

      <!-- Pipeline Selection -->
      <div class="form-group">
        <label class="form-label">Presentation Pipeline</label>
        <div class="radio-tiles">
          <div class="radio-tile ${isPipgm1 ? "selected" : ""}" data-pipeline="pipgm1">
            <span class="tile-title">Pi Program 1</span>
            <span class="tile-desc">Primary service pipeline</span>
          </div>
          <div class="radio-tile ${!isPipgm1 ? "selected" : ""}" data-pipeline="pipgm2">
            <span class="tile-title">Pi Program 2</span>
            <span class="tile-desc">Secondary / split pipeline</span>
          </div>
        </div>
      </div>

      <!-- Matrix Routing Destination -->
      <div class="form-group">
        <label class="form-label">Pi Matrix Routing Destination</label>
        <select class="select-input" id="select-matrix-route">
          <option value="both_projectors" ${state.setup.matrixRoute === "both_projectors" ? "selected" : ""}>Both Projectors (Stage Left & Right)</option>
          <option value="landscape_screen" ${state.setup.matrixRoute === "landscape_screen" ? "selected" : ""}>Landscape Screen (Side Wall)</option>
          <option value="all_displays" ${state.setup.matrixRoute === "all_displays" ? "selected" : ""}>All Church Displays</option>
          <option value="none" ${state.setup.matrixRoute === "none" ? "selected" : ""}>Keep Existing Matrix Routing</option>
        </select>
      </div>

      <!-- Projector Picture Mute Option -->
      <label class="checkbox-row">
        <input type="checkbox" id="chk-unblank" ${state.setup.unblankProjectors ? "checked" : ""} />
        <div>
          <div class="checkbox-label">Unblank Projectors (Turn OFF Pic Mute)</div>
          <div class="checkbox-hint">Ensures physical projector beams open when activating live</div>
        </div>
      </label>

      <!-- Cue Slide 1 -->
      <label class="checkbox-row">
        <input type="checkbox" id="chk-cue" ${state.setup.cueSlide === 1 ? "checked" : ""} />
        <div>
          <div class="checkbox-label">Cue Slide 1 Immediately</div>
          <div class="checkbox-hint">Prepares first slide on the pipeline stage</div>
        </div>
      </label>

      <button class="btn-primary" id="btn-apply-setup" ${isBusy ? "disabled" : ""}>
        ${isBusy ? `<span class="spinner"></span> Configuring Pipeline...` : `🚀 Apply Pipeline & Go Live`}
      </button>

      <div class="footer-actions">
        <button class="link-btn" id="btn-back-step1">◀ Back to Step 1 (Push Content)</button>
      </div>
    </section>
  `;
}

function renderStep3View() {
  const current = state.live.currentSlide;
  const total = state.live.totalSlides;
  const isFirst = current <= 1;
  const isLast = current >= total;

  const currentSlideName =
    state.live.pages && state.live.pages[current - 1]
      ? state.live.pages[current - 1].name || `Slide ${current}`
      : `Slide ${current}`;

  const routeLabel =
    state.live.matrixRoute === "both_projectors"
      ? "Both Projectors"
      : state.live.matrixRoute === "landscape_screen"
      ? "Landscape Screen"
      : state.live.matrixRoute === "all_displays"
      ? "All Displays"
      : "Custom Route";

  return `
    <section class="view-card">
      <!-- Live Status Banner -->
      <div class="live-banner">
        <div class="live-pill">
          <span class="live-pulse"></span>
          <span>LIVE: ${state.live.pipelineId.toUpperCase()}</span>
        </div>
        <div class="live-routing-badge">➔ ${routeLabel}</div>
      </div>

      <!-- Prominent Slide Display -->
      <div class="slide-display-box">
        <div class="slide-count-label">Current Slide</div>
        <div class="slide-number-big">${current} <span style="font-size: 20px; color: var(--text-dim); font-weight: 500;">/ ${total}</span></div>
        <div class="slide-title-preview">${currentSlideName}</div>
      </div>

      <!-- Big Navigation Buttons -->
      <div class="nav-buttons-row">
        <button class="btn-nav btn-nav-prev" id="btn-prev-slide" ${isFirst ? "disabled" : ""}>
          <span>◀ PREVIOUS</span>
          <span class="nav-key-hint">[Left Arrow]</span>
        </button>
        <button class="btn-nav btn-nav-next" id="btn-next-slide" ${isLast ? "disabled" : ""}>
          <span>NEXT ▶</span>
          <span class="nav-key-hint">[Right / Space]</span>
        </button>
      </div>

      <!-- Quick Thumbnail Drawer -->
      ${
        state.live.pages && state.live.pages.length > 0
          ? `
        <div class="form-label" style="margin-top: 4px;">Jump to Slide</div>
        <div class="thumbnails-strip">
          ${state.live.pages
            .map(
              (p, idx) => `
            <div class="thumb-card ${idx + 1 === current ? "active" : ""}" data-jump="${idx + 1}" title="Slide ${idx + 1}">
              <img src="${p.url}" alt="Slide ${idx + 1}" />
              <span class="thumb-number">${idx + 1}</span>
            </div>
          `
            )
            .join("")}
        </div>
      `
          : ""
      }

      <!-- Emergency Shutter & Blackout Controls -->
      <div class="form-label" style="margin-top: 6px;">Output & Shutter Controls</div>
      <div class="quick-controls-grid">
        <button class="btn-toggle-active btn-toggle-ftb ${state.live.ftb ? "active" : ""}" id="btn-toggle-ftb">
          <span>⚫ ${state.live.ftb ? "FTB ACTIVE (BLACK)" : "Fade to Black (FTB)"}</span>
          <span style="font-size: 9px; opacity: 0.8;">[Key B]</span>
        </button>

        <button class="btn-toggle-active btn-toggle-picmute ${state.live.picMute ? "active" : ""}" id="btn-toggle-picmute">
          <span>📽️ ${state.live.picMute ? "PROJECTOR MUTED" : "Pic Mute (Beam)"}</span>
          <span style="font-size: 9px; opacity: 0.8;">[Key M]</span>
        </button>
      </div>

      <div class="footer-actions">
        <button class="link-btn" id="btn-restart-slide1">⏮ Restart (Slide 1)</button>
        <button class="link-btn" id="btn-back-setup">⚙️ Pipeline Settings</button>
      </div>
    </section>
  `;
}

// -------------------------------------------------------------
// Main Render & Event Binding
// -------------------------------------------------------------

function render() {
  const appContainer = document.getElementById("app");
  if (!appContainer) return;

  const isGraphics = state.appMode === "graphics";
  let viewHtml = "";
  if (isGraphics) {
    viewHtml = renderGraphicsView();
  } else if (state.currentStep === 1) {
    viewHtml = renderStep1View();
  } else if (state.currentStep === 2) {
    viewHtml = renderStep2View();
  } else if (state.currentStep === 3) {
    viewHtml = renderStep3View();
  }

  appContainer.innerHTML = `
    ${renderHeader()}
    ${renderProgressBar()}
    ${isGraphics ? "" : renderStepTabs()}
    ${renderToast()}
    ${viewHtml}
  `;

  attachEventHandlers();
}

function attachEventHandlers() {
  // App Mode Switcher (Slides vs Graphics)
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      if (mode && mode !== state.appMode) {
        state.appMode = mode;
        render();
      }
    });
  });

  // Broadcast Graphics Handlers
  const btnExportGraphics = document.getElementById("btn-export-graphics");
  if (btnExportGraphics) btnExportGraphics.addEventListener("click", handleExportGraphicsDeck);

  const btnReexportGraphics = document.getElementById("btn-reexport-graphics");
  if (btnReexportGraphics) btnReexportGraphics.addEventListener("click", handleExportGraphicsDeck);

  const btnFlyToggle = document.getElementById("btn-fly-toggle");
  if (btnFlyToggle) {
    btnFlyToggle.addEventListener("click", () => {
      if (state.graphics.onAir) {
        handleGraphicOffAir();
      } else {
        handleFlyCuedGraphic();
      }
    });
  }

  const btnGraphicOffAir = document.getElementById("btn-graphic-offair");
  if (btnGraphicOffAir) btnGraphicOffAir.addEventListener("click", handleGraphicOffAir);

  const btnPrevGraphic = document.getElementById("btn-prev-graphic");
  if (btnPrevGraphic) btnPrevGraphic.addEventListener("click", () => handleGraphicNav("prev"));

  const btnNextGraphic = document.getElementById("btn-next-graphic");
  if (btnNextGraphic) btnNextGraphic.addEventListener("click", () => handleGraphicNav("next"));

  document.querySelectorAll("[data-cue-graphic]").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.cueGraphic, 10);
      if (idx) {
        state.graphics.cuedIndex = idx;
        render();
      }
    });
  });

  const selectMovement = document.getElementById("select-graphic-movement");
  if (selectMovement) {
    selectMovement.addEventListener("change", (e) => {
      state.graphics.movement = e.target.value;
    });
  }

  const selectAutohide = document.getElementById("select-graphic-autohide");
  if (selectAutohide) {
    selectAutohide.addEventListener("change", (e) => {
      state.graphics.autoHideMs = parseInt(e.target.value, 10);
    });
  }

  const selectSlot = document.getElementById("select-graphic-slot");
  if (selectSlot) {
    selectSlot.addEventListener("change", (e) => {
      state.graphics.slot = parseInt(e.target.value, 10);
    });
  }

  const selectPlayer = document.getElementById("select-graphic-player");
  if (selectPlayer) {
    selectPlayer.addEventListener("change", (e) => {
      state.graphics.mediaPlayer = parseInt(e.target.value, 10);
    });
  }

  // Step Tabs Navigation
  document.querySelectorAll(".step-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const step = parseInt(tab.dataset.step, 10);
      if (step && step !== state.currentStep) {
        state.currentStep = step;
        render();
      }
    });
  });

  // Step 1: Push Buttons
  const btnPush = document.getElementById("btn-push");
  if (btnPush) btnPush.addEventListener("click", handlePushContent);

  const btnRepush = document.getElementById("btn-repush");
  if (btnRepush) btnRepush.addEventListener("click", handlePushContent);

  const btnGotoStep2 = document.getElementById("btn-goto-step2");
  if (btnGotoStep2) {
    btnGotoStep2.addEventListener("click", () => {
      state.currentStep = 2;
      render();
    });
  }

  // Step 2: Form Controls
  document.querySelectorAll(".radio-tile").forEach((tile) => {
    tile.addEventListener("click", () => {
      state.setup.pipelineId = tile.dataset.pipeline;
      render();
    });
  });

  const selectMatrix = document.getElementById("select-matrix-route");
  if (selectMatrix) {
    selectMatrix.addEventListener("change", (e) => {
      state.setup.matrixRoute = e.target.value;
    });
  }

  const chkUnblank = document.getElementById("chk-unblank");
  if (chkUnblank) {
    chkUnblank.addEventListener("change", (e) => {
      state.setup.unblankProjectors = e.target.checked;
    });
  }

  const chkCue = document.getElementById("chk-cue");
  if (chkCue) {
    chkCue.addEventListener("change", (e) => {
      state.setup.cueSlide = e.target.checked ? 1 : null;
    });
  }

  const btnApplySetup = document.getElementById("btn-apply-setup");
  if (btnApplySetup) btnApplySetup.addEventListener("click", handleApplySetup);

  const btnBackStep1 = document.getElementById("btn-back-step1");
  if (btnBackStep1) {
    btnBackStep1.addEventListener("click", () => {
      state.currentStep = 1;
      render();
    });
  }

  // Step 3: Live Navigation Buttons
  const btnPrev = document.getElementById("btn-prev-slide");
  if (btnPrev) btnPrev.addEventListener("click", () => handleSlideNav("prev"));

  const btnNext = document.getElementById("btn-next-slide");
  if (btnNext) btnNext.addEventListener("click", () => handleSlideNav("next"));

  document.querySelectorAll("[data-jump]").forEach((thumb) => {
    thumb.addEventListener("click", () => {
      const page = parseInt(thumb.dataset.jump, 10);
      if (page) handleSlideNav("gotoPage", page);
    });
  });

  // Emergency & Shutter Buttons
  const btnFtb = document.getElementById("btn-toggle-ftb");
  if (btnFtb) btnFtb.addEventListener("click", handleToggleFtb);

  const btnPicMute = document.getElementById("btn-toggle-picmute");
  if (btnPicMute) btnPicMute.addEventListener("click", handleTogglePicMute);

  const btnRestart = document.getElementById("btn-restart-slide1");
  if (btnRestart) btnRestart.addEventListener("click", () => handleSlideNav("gotoPage", 1));

  const btnBackSetup = document.getElementById("btn-back-setup");
  if (btnBackSetup) {
    btnBackSetup.addEventListener("click", () => {
      state.currentStep = 2;
      render();
    });
  }
}

// Initial mount
document.addEventListener("DOMContentLoaded", render);
if (document.readyState === "complete" || document.readyState === "interactive") {
  render();
}
