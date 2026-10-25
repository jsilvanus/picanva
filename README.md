# picanva

Canva slide bridge for the Pi stack. A Canva design (pushed by the Canva app, or exported through the Canva Connect API) becomes one media item per page in **piprogram**, which shows the slides. picanva also forwards navigation and FTB/mute to piprogram.

Part of the Pi split (see `pimatrix` and `piprogram`). Node 24, ESM, no build step, systemd on bare metal (no Docker).

## Run

```bash
npm install
PICANVA_PIPROGRAM_URL=http://127.0.0.1:3000 npm start
```

Configuration is environment only: see `deploy/pi/picanva.env.example`. `PICANVA_MODE=production` refuses to start without `PICANVA_API_KEY`.

## API

`openapi/openapi.yaml` is the contract. Main routes:

- `POST /api/v1/canva/push`: hand a design's pages to piprogram.
- `POST /api/v1/canva/control`: next, prev, gotoPage, ftb, mute, play, pause, stop, restart.
- `GET /api/v1/canva/items[/:itemId]`, `GET /health`.

## CLI

```bash
PICANVA_URL=http://kirkonpi.local:3100 PICANVA_API_KEY=... node cli/picanva.mjs push DAF_CHURCH_2026 --export https://export.canva.com/.../page-1.png
node cli/picanva.mjs control gotoPage --design DAF_CHURCH_2026 --page 2
```

The CLI is hand-written over the HTTP API in `openapi/openapi.yaml`. Generating it from the spec is not done yet.

## Deploy (Pi)

Copy the repo to `/home/pi/apps/picanva`, write `/home/pi/apps/picanva.env` from the example, then:

```bash
cp deploy/pi/picanva.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now picanva
```

## Hand-off and status

See `docs/handoff.md`. Unverified against the live Canva API and a real piprogram: the export paths, the Canva app's new route names, and the end-to-end run on the Pi.

## Tests

```bash
npm test
```

Tests use a fake piprogram and fake export hosts. No network.
