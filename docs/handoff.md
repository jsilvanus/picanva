# picanva → piprogram hand-off

picanva never shows slides. It turns Canva pages into media items in piprogram and tells piprogram what to cue. piprogram owns the display (`/pipgm/:id/stage`, the playlist and the slide state).

## Flow

1. The Canva app (or `picanva push --auto-export`) sends a design to `POST /api/v1/canva/push` with `exportUrls` (one URL per page) or `autoExport: true` (picanva exports through the Canva Connect API).
2. picanva downloads each page (https, allowed Canva host, no redirects, size cap `PICANVA_MAX_ASSET_BYTES`).
3. For each page picanva calls piprogram `POST /api/v1/pipgm/items/media` with `kind` = `image` (png) or `video` (mp4), base64 `dataBase64`, `fit: "contain"`, the target pipeline, and `cueImmediately` only on page 1.
4. Navigation: `gotoPage` calls piprogram `POST /api/v1/pipgm/pipelines/{id}/control` with `{action: "gotoItem", itemId}`. `next`/`prev` use `advanceItemOnEnd: true`. `ftb` calls `/ftb` and `mute` calls `/audio`.

## What is not supported yet

- **Embed mode** (a live Canva iframe on the slide output) needs a Canva item kind in piprogram. That is piprogram 1.1. Until then picanva refuses pushes without exported pages.
- **Size:** media goes out base64 in a JSON body, and piprogram takes 50 MB bodies, so a page is capped at 37 MB raw.
- **Records** are in memory. After a restart picanva forgets which piprogram items belong to which design. piprogram keeps the media.

## Unverified

- The Canva Connect export paths (`POST /v1/exports`, `GET /v1/exports/{id}`) and their response shapes follow the pimatrix adapter. Not checked against the live Canva API.
- Checked against piprogram's `openapi/openapi.yaml` (createMediaItem, controlPipeline, setFadeToBlack, setPipelineAudio). The client is hand-written: piprogram's generated client is not published, so picanva does not depend on it.
- The Canva app plugin lives in Canva's developer portal, not in this repo. Its calls must move from `/api/v1/pipgm/canva/*` to `/api/v1/canva/*`.
