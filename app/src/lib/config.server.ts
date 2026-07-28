import process from "node:process";

// Server-only config. The .server.ts suffix prevents Vite from bundling
// this file into the client — values here never reach the browser.
//
// df-deploy injects the Windows service environment before Node starts. Read
// process.env inside a helper/handler so tests and service restarts can provide
// a complete configuration without copying values into browser bundles.
//
// When to use which env-access pattern:
//   - .server.ts module (this file): server-only helpers reused across
//     handlers. Wrap reads in a function so they run per-request.
//   - inline process.env inside a route/serverFn handler: one-off reads not
//     reused elsewhere.
//   - import.meta.env.VITE_FOO: PUBLIC config readable from both client
//     and server (analytics IDs, public URLs). Define in .env with the
//     VITE_ prefix. Never put secrets here — they ship to the browser.

export function getServerConfig() {
  return {
    nodeEnv: process.env.NODE_ENV,
    publicOrigin: process.env.HDEX_PUBLIC_ORIGIN,
    mcpUrl: process.env.HDEX_HIGGSFIELD_MCP_URL,
    oauthCookieSecret: process.env.HDEX_HIGGSFIELD_OAUTH_COOKIE_SECRET,
    openAiApiKey: process.env.OPENAI_API_KEY,
  };
}
