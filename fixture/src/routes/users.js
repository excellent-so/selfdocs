// The users API surface.
import { Router } from "express";
import { User } from "../models/user.js";

export const usersRouter = Router();

// GET /users — list all users.
usersRouter.get("/", async (_req, res) => {
  res.json(await User.all());
});

// POST /users — create a user.
usersRouter.post("/", async (req, res) => {
  const user = await User.create(req.body);
  res.status(201).json(user);
});
