/**
 * Build-time configuration defined via environment variables.
 * Baked into the bundle during `npm run build`.
 */
const env = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : (typeof process !== "undefined" ? process.env : {});

export const CONFIG = Object.freeze({
  appName: env.VITE_APP_NAME || "Church Slide Bridge",
  gatewayUrl: (env.VITE_GATEWAY_URL || "https://gateway.local:8443").replace(/\/+$/, ""),
  gatewayApiKey: env.VITE_GATEWAY_API_KEY || "",
  isDev: Boolean(env.DEV || env.NODE_ENV !== "production"),
});
