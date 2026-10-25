// Canva Connect API client for server-side export. Endpoint paths and response shapes are UNVERIFIED
// against the live Canva API: they follow the export flow the pimatrix adapter used (POST /v1/exports).
import { exportPayload } from "./canva.mjs";

export class CanvaConnectError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanvaConnectError";
  }
}

export function createCanvaConnectClient({ baseUrl, accessToken, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function call(method, path, body) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new CanvaConnectError(`Canva Connect API returned HTTP ${response.status}`);
    return response.json();
  }

  return {
    /** Starts an export and polls it until it succeeds, fails or the timeout passes. Returns the download URLs. */
    async exportDesign({ designId, exportFormat, orientation, pollMs, timeoutMs }) {
      const started = await call("POST", "/v1/exports", exportPayload(designId, exportFormat, orientation));
      const jobId = started?.job?.id;
      if (!jobId) throw new CanvaConnectError("Canva Connect API returned no export job id");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = (await call("GET", `/v1/exports/${encodeURIComponent(jobId)}`))?.job ?? {};
        if (job.status === "success") {
          const urls = Array.isArray(job.urls) ? job.urls.filter((u) => typeof u === "string") : [];
          if (urls.length === 0) throw new CanvaConnectError("Canva export succeeded without download URLs");
          return urls;
        }
        if (job.status === "failed") throw new CanvaConnectError("Canva export failed");
        if (Date.now() >= deadline) throw new CanvaConnectError("Canva export timed out");
        await sleep(pollMs);
      }
    }
  };
}
