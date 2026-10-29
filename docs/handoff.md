# picanva Architecture & Hand-off

`picanva` is the Canva App (SDK plugin) that runs inside Canva. It connects from the user's browser in Canva directly to **Pi Gateway**, allowing operators to stage media in **Pi Program**, configure **Pi Matrix** display routes, and operate live presentations from Canva.

There is no separate receiver daemon running on the Pi; Pi Gateway exposes scoped `/api/v1/canva/*` endpoints that proxy to Pi Program and Pi Matrix.

---

## 3-Phase Operational Flow

```
[ Step 1: Push Content ] ➔ [ Step 2: Presentation Setup ] ➔ [ Step 3: Live Control ]
```

### 1. Step 1: Push Content
* Operator clicks **"Push Content to Church"** in Canva.
* The plugin triggers Canva Apps SDK (`@canva/design` `requestExport`) with uncompressed PNG export (`zipped: "never"`).
* The plugin sends the export URLs and titles to Pi Gateway:
  `POST /api/v1/canva/push`
* Pi Gateway fetches the assets and stores them as media items in Pi Program.
* Staging content does not affect live displays or active playback.

### 2. Step 2: Presentation Setup
* Operator selects:
  * **Target Pipeline**: `Pi Program 1` (`pipgm1`) or `Pi Program 2` (`pipgm2`).
  * **Matrix Routing Destination**: `Both Projectors` (`both_projectors`), `Landscape Screen` (`landscape_screen`), `All Displays` (`all_displays`), or `Keep Current Route` (`none`).
  * **Projector Shutter**: Checkbox to automatically unblank projector beams (`Turn OFF Pic Mute`) when arming the presentation.
  * **Cue**: Pre-stages Slide 1 on the pipeline stage.
* Operator clicks **"🚀 Apply Pipeline & Go Live"**:
  `POST /api/v1/canva/setup`
* Gateway arms the presentation on the selected pipeline, triggers Pi Matrix routing, and unblanks projectors if requested.

### 3. Step 3: Live Presentation Controls
* **Slide Navigation**:
  * Large `◀ PREVIOUS` and `NEXT ▶` buttons.
  * Keyboard navigation: Left/Right arrows, Spacebar, PageUp/PageDown.
  * Thumbnail drawer to jump directly to any slide index (`POST /api/v1/canva/control` with `action: "gotoPage"`).
* **Emergency & Shutter Controls**:
  * **Fade to Black (FTB)**: Toggles slide blackout on the active Pi Program pipeline (`Key B`).
  * **Projector Pic Mute**: Toggles hardware projector beam shutter (`Key M`).
  * **Restart**: Cues Slide 1.

---

## Build-time Configuration

Environment variables baked into the static bundle during `npm run build`:
* `VITE_APP_NAME`: Build-time plugin display name (e.g. `"Keskuskirkko Slide Bridge"`).
* `VITE_GATEWAY_URL`: Target Pi Gateway HTTPS URL (e.g. `"https://gateway.keskuskirkko.fi:8443"`).
* `VITE_GATEWAY_API_KEY`: Secret authentication key for the gateway's Canva routes.

---

## Security Model

* **HTTPS Enforcement**: Canva runs inside an HTTPS iframe; Gateway must be accessible over HTTPS.
* **CORS**: Pi Gateway restricts CORS on Canva routes to Canva domains (`https://*.canva-apps.com`).
* **Scoped Endpoints**: Gateway only allows safe, pre-whitelisted presentation and routing presets:
  * `/push`: Media upload to Pi Program.
  * `/setup`: Armed pipeline & preset matrix routes.
  * `/control`: Slide navigation & FTB.
  * `/projector/pic-mute`: Hardware projector beam blanking.
  * `/status`: Presentation and health polling.
