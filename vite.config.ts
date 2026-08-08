import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * v12 — the surrogate listens. The Sarvam speech-to-text call is proxied by the DEV
 * SERVER, not made from the page.
 *
 * Two things are bought by the indirection, and both matter:
 *
 *  1. THE KEY NEVER ENTERS THE BUNDLE. It is read here, in Node, from a variable with
 *     no `VITE_` prefix — and that missing prefix is the whole mechanism: Vite refuses
 *     to expose an unprefixed var to client code, so `SARVAM_API_KEY` cannot be leaked
 *     by an `import.meta.env` reference someone adds later. What reaches the browser is
 *     `__STT_READY__`, a boolean.
 *  2. NO CORS. The page posts to same-origin `/api/stt`. Whether api.sarvam.ai sends an
 *     `Access-Control-Allow-Origin` for a browser POST is not documented, and a demo
 *     should not be the thing that finds out.
 *
 * THE COST, stated plainly: this is `npm run dev` only. `vite build` + `vite preview`
 * has no proxy and the mic will 404 there. Acceptable because this repo is a dev
 * surrogate that is only ever run with `npm run dev` — but it is the reason voice input
 * would move to the cloud hub (alongside the fish.audio client) if it ever needed to
 * work from a built bundle or from the chat/board surfaces.
 */
export default defineConfig(({ mode }) => {
  // "" as the third argument = load UNPREFIXED vars too. The default ("VITE_") would
  // silently hand back an empty key and the mic would just never work.
  const env = loadEnv(mode, process.cwd(), "");
  const sarvamKey = (env.SARVAM_API_KEY ?? "").trim();
  const sarvamBase = (env.SARVAM_BASE_URL ?? "https://api.sarvam.ai").trim();

  return {
    plugins: [react()],
    define: {
      // A boolean, never the key — so the mic button can explain why it is disabled
      // BEFORE someone presses it and waits for a 401.
      __STT_READY__: JSON.stringify(Boolean(sarvamKey)),
    },
    server: {
      // host: true so a phone/tablet on the LAN can load the surrogate — same reason
      // the chat/board UIs do it. Port 5175 keeps all three surfaces runnable side by
      // side (chat = 5173, board = 5174, bixby = 5175).
      //
      // v12 CAVEAT: getUserMedia needs a SECURE CONTEXT. `localhost:5175` is one; the
      // LAN address this also serves is not, and there the mic silently never appears.
      // Load the surrogate on localhost when you want to speak to it.
      host: true,
      port: 5175,
      proxy: {
        "/api/stt": {
          target: sarvamBase,
          changeOrigin: true,
          // A function, not a regex replace: this path has exactly one destination.
          rewrite: () => "/speech-to-text",
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              // Sarvam authenticates on this header, NOT a bearer Authorization.
              proxyReq.setHeader("api-subscription-key", sarvamKey);
            });
          },
        },
      },
    },
  };
});
