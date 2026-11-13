import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/epistemics-playground/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
