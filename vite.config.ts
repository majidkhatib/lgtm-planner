import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://m-shahidi.com/lgtm-planner/
export default defineConfig({
  base: "/lgtm-planner/",
  plugins: [react()],
});
