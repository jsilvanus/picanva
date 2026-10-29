import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 3100,
    host: "0.0.0.0",
    cors: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: true,
  },
});
