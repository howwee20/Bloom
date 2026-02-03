import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiKey = process.env.BLOOM_READ_KEY;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        headers: apiKey ? { "x-api-key": apiKey } : {}
      }
    }
  }
});
