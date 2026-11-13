import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const LOCAL_PORT = 5173;
const API_SERVER = "http://127.0.0.1:8095";

export default defineConfig({
  root: "web",
  // GitHub Pages serves the app under /epistemics-playground/. The Pages workflow sets VITE_BASE for that.
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  // Local use: the app and the API share one address, so one forwarded port is enough.
  // Requests to /api go to the API server on this machine, with the prefix removed.
  server: {
    host: "127.0.0.1",
    port: LOCAL_PORT,
    strictPort: true,
    proxy: { "/api": { target: API_SERVER, rewrite: (path) => path.replace(/^\/api/, ""), ws: true } },
  },
});
