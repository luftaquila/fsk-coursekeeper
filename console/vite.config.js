import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Relative base: the same build runs from GitHub Pages' /fsk-coursekeeper/ path
// or any static host. sqlite-wasm loads its .wasm next to the module, so keep it
// out of dependency pre-bundling; the package ships Vue sources.
export default defineConfig({
  base: "./",
  plugins: [vue()],
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm", "fsk-coursekeeper"] },
  worker: { format: "es" },
  build: { target: "es2022" },
});
