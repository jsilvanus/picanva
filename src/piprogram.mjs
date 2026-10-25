// HTTP client for piprogram, the service that owns slide display.
// Paths and bodies follow piprogram's openapi/openapi.yaml (createMediaItem, controlPipeline, setFadeToBlack, setPipelineAudio).

export class PiprogramError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PiprogramError";
    this.status = status;
  }
}

export function createPiprogramClient({ baseUrl, apiKey, timeoutMs, fetchImpl = fetch }) {
  async function request(method, path, body) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // piprogram's OpenAPI declares the x-api-key scheme.
    if (apiKey) headers["x-api-key"] = apiKey;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new PiprogramError(502, `piprogram unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message ?? `piprogram answered HTTP ${response.status}`;
      throw new PiprogramError(response.status >= 500 ? 502 : response.status, message);
    }
    return payload;
  }

  return {
    /** Adds an uploaded image or video item to piprogram's library (and optionally cues it). */
    createMediaItem: (input) => request("POST", "/api/v1/pipgm/items/media", input),
    control: (pipelineId, input) =>
      request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/control`, input),
    ftb: (pipelineId, input) =>
      request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/ftb`, input),
    audio: (pipelineId, input) =>
      request("POST", `/api/v1/pipgm/pipelines/${encodeURIComponent(pipelineId)}/audio`, input)
  };
}
