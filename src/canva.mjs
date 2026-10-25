// Pure helpers for Canva designs and exported assets. No network here.

const DESIGN_ID = /^[A-Za-z0-9_-]{3,64}$/;

/** Accepts a bare design id or a Canva design URL and returns the design id, or null. */
export function designIdFrom(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (DESIGN_ID.test(raw)) return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const match = /\/design\/([A-Za-z0-9_-]+)/.exec(parsed.pathname);
  return match && DESIGN_ID.test(match[1]) ? match[1] : null;
}

/** True when the URL is https and its host is one of the allowed suffixes (e.g. canva.com). */
export function isAllowedAssetUrl(value, allowedSuffixes) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  return allowedSuffixes.some((suffix) => parsed.hostname === suffix || parsed.hostname.endsWith(`.${suffix}`));
}

/** Maps Canva export format to the piprogram media kind, file extension and MIME type. */
export function mediaFormat(exportFormat) {
  return exportFormat === "mp4"
    ? { kind: "video", ext: "mp4", mimeType: "video/mp4" }
    : { kind: "image", ext: "png", mimeType: "image/png" };
}

/** Canva Connect export payload (horizontal or vertical 1080p for mp4). */
export function exportPayload(designId, exportFormat, orientation) {
  if (exportFormat === "png") {
    return { design_id: designId, format: { type: "png" } };
  }
  return {
    design_id: designId,
    format: { type: "mp4", quality: orientation === "portrait" ? "vertical_1080p" : "horizontal_1080p" }
  };
}
