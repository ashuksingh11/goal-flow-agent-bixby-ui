import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true so a phone/tablet on the LAN can load the surrogate — same reason
    // the chat/board UIs do it. Port 5175 keeps all three surfaces runnable side by
    // side (chat = 5173, board = 5174, bixby = 5175).
    host: true,
    port: 5175,
  },
});
