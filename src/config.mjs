// Configuration from environment variables. Every PICANVA_* name is documented in deploy/pi/picanva.env.example.

// piprogram takes JSON bodies up to 50 MB and media is sent base64 (x4/3), so raw assets stay under 37 MB.
const MAX_ASSET_BYTES_LIMIT = 37 * 1024 * 1024;

function list(value) {
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function integer(value, fallback, name, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function httpUrl(value, name) {
  if (!value?.trim()) return undefined;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP or HTTPS URL without embedded credentials`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function loadConfig(env = process.env) {
  const mode = env.PICANVA_MODE?.trim() || "simulation";
  if (mode !== "simulation" && mode !== "production") {
    throw new Error('PICANVA_MODE must be "simulation" or "production"');
  }

  const apiKey = env.PICANVA_API_KEY?.trim() || undefined;
  if (mode === "production" && !apiKey) {
    throw new Error("PICANVA_API_KEY is required when PICANVA_MODE=production");
  }

  const piprogramUrl = httpUrl(env.PICANVA_PIPROGRAM_URL, "PICANVA_PIPROGRAM_URL");
  if (!piprogramUrl) {
    throw new Error("PICANVA_PIPROGRAM_URL is required: picanva hands slides to piprogram");
  }

  return {
    host: env.PICANVA_HOST?.trim() || "127.0.0.1",
    port: integer(env.PICANVA_PORT, 3100, "PICANVA_PORT", 1, 65535),
    mode,
    apiKey,
    piprogramUrl,
    piprogramApiKey: env.PICANVA_PIPROGRAM_API_KEY?.trim() || undefined,
    piprogramTimeoutMs: integer(env.PICANVA_PIPROGRAM_TIMEOUT_MS, 15000, "PICANVA_PIPROGRAM_TIMEOUT_MS", 500, 120000),
    // Hosts that exported assets may be downloaded from (suffix match, https only).
    assetHosts: list(env.PICANVA_ASSET_HOSTS ?? "canva.com,canva-usercontent.com"),
    maxAssetBytes: integer(env.PICANVA_MAX_ASSET_BYTES, 30 * 1024 * 1024, "PICANVA_MAX_ASSET_BYTES", 1, MAX_ASSET_BYTES_LIMIT),
    // Canva Connect API for server-side export. Without a token, only pushes with explicit exportUrls work.
    canvaApiBaseUrl: httpUrl(env.CANVA_API_BASE_URL, "CANVA_API_BASE_URL") ?? "https://api.canva.com/rest",
    canvaAccessToken: env.CANVA_ACCESS_TOKEN?.trim() || undefined,
    exportPollMs: integer(env.PICANVA_EXPORT_POLL_MS, 2000, "PICANVA_EXPORT_POLL_MS", 100, 60000),
    exportTimeoutMs: integer(env.PICANVA_EXPORT_TIMEOUT_MS, 180000, "PICANVA_EXPORT_TIMEOUT_MS", 1000, 900000)
  };
}
