import { CONFIG } from "./config.mjs";
import { exportDesignPages, isRunningInCanva } from "./services/canva-sdk.mjs";
import {
  pushContent,
  setupPresentation,
  controlSlide,
  toggleFtb,
  setProjectorPicMute,
  getGatewayStatus,
} from "./services/gateway-api.mjs";

// App reactive state
const state = {
  currentStep: 1, // 1: Push, 2: Setup, 3: Live Control
  isExporting: false,
  isPushing: false,
  isSettingUp: false,
  isControlling: false,
  gatewayStatus: "checking", // online | simulated | offline | checking

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
    render();

    const exportResult = await exportDesignPages();
    state.isExporting = false;

    if (exportResult.status === "aborted") {
      showToast("Export was cancelled.", "info");
      render();
      return;
    }

    if (!exportResult.exportBlobs || exportResult.exportBlobs.length === 0) {
      showToast("No pages were exported from Canva.", "error");
      render();
      return;
    }

    state.isPushing = true;
    render();

    const pushResult = await pushContent({
      title: exportResult.title || "Canva Slides",
      pages: exportResult.exportBlobs,
    });

    state.isPushing = false;
    state.staged = {
      presentationId: pushResult.presentationId || `pres_${Date.now()}`,
      title: exportResult.title || "Canva Presentation",
      pageCount: exportResult.exportBlobs.length,
      pages: exportResult.exportBlobs,
    };

    // Auto advance to Step 2
    state.currentStep = 2;
    showToast(`Pushed ${exportResult.exportBlobs.length} slides to church storage!`, "success");
    render();
  } catch (err) {
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
    await setProjectorPicMute({ muted: newMute });
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
  // Only handle shortcuts when on Step 3
  if (state.currentStep !== 3) return;

  if (e.target && ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;

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
    </header>
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

  let viewHtml = "";
  if (state.currentStep === 1) {
    viewHtml = renderStep1View();
  } else if (state.currentStep === 2) {
    viewHtml = renderStep2View();
  } else if (state.currentStep === 3) {
    viewHtml = renderStep3View();
  }

  appContainer.innerHTML = `
    ${renderHeader()}
    ${renderStepTabs()}
    ${renderToast()}
    ${viewHtml}
  `;

  attachEventHandlers();
}

function attachEventHandlers() {
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
