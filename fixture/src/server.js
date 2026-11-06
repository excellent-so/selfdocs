// Express app wiring: mount the routers.
import express from "express";
import { usersRouter } from "./routes/users.js";

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use("/users", usersRouter);
  return app;
}
