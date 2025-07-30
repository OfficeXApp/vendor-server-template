import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Define the base path for your React app, matching the Fastify route
const BASE_PATH = "/v1/dashboard/customer/"; // IMPORTANT: Make sure this matches CUSTOMER_DASHBOARD_ROUTE in server.ts and ends with a slash

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5201,
  },
  base: BASE_PATH, // Add this line
  build: {
    outDir: "dist", // Ensure this is set, it usually is by default
    assetsDir: "assets", // Ensure this is set, it usually is by default
  },
});
