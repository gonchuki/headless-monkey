import { Router, Request, Response } from "express";
import { UserRepo } from "../repositories/userRepo";
import { UserService } from "../services/userService";
import type { Db } from "../db/database";

export function createUsersRouter(db: Db): Router {
  const router: Router = Router();
  const userRepo = new UserRepo(db);
  const userService = new UserService(userRepo);

  router.get("/", (_req: Request, res: Response) => {
    try {
      const users = userService.list();
      res.json(users);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/", async (req: Request, res: Response) => {
    try {
      const { login, password } = req.body;
      if (!login || !password) {
        return res.status(422).json({ error: "Login and password are required" });
      }
      const id = await userService.create({ login, password });
      res.status(201).json({ id, login });
    } catch (err) {
      const status = (err as Error & { statusCode?: number }).statusCode;
      if (status === 409) {
        return res.status(409).json({ error: "Duplicate login" });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { password, disabled } = req.body;
      await userService.update(id, { password, disabled });
      const user = userRepo.findById(id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ id: user.id, login: user.login, disabled: Boolean(user.disabled) });
    } catch (err) {
      const status = (err as Error & { statusCode?: number }).statusCode;
      if (status === 404) {
        return res.status(404).json({ error: "User not found" });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await userService.remove(id);
      res.status(204).send();
    } catch (err) {
      const status = (err as Error & { statusCode?: number }).statusCode;
      if (status === 404) {
        return res.status(404).json({ error: "User not found" });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
