import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { getApiPort, getClientPort, getHost } from "./server/config";

const host = getHost();
const apiPort = getApiPort();
const clientPort = getClientPort();

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: clientPort,
    proxy: {
      "/api": `http://${host}:${apiPort}`
    }
  },
  root: "client",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true
  }
});
