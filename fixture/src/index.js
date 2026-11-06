// Entry point: boot the HTTP server.
import { createServer } from "./server.js";

const port = process.env.PORT || 8080;
createServer().listen(port, () => {
  console.log(`widgetco-api listening on :${port}`);
});
