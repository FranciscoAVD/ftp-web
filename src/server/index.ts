// Bun server entry

import { app } from "@s/app";

Bun.serve({
  port: 3000,
  fetch: app.fetch,
});
