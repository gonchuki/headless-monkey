import crypto from "node:crypto";
import { Router, Request, Response, NextFunction } from "express";
import { signToken } from "../auth/jwt";
import { UserRepo } from "../repositories/userRepo";
import { UserService } from "../services/userService";
import { loadAppEnv } from "../config/env";
import type { Db } from "../db/database";

export function createAuthRouter(
  db: Db,
  requireAuthMiddleware: (req: Request, res: Response, next: NextFunction) => void
): Router {
  const router: Router = Router();
  const userRepo = new UserRepo(db);
  const userService = new UserService(userRepo);

  // Login is public
  router.post("/login", async (req: Request, res: Response) => {
    try {
      const { login, password } = req.body;

      if (!login || !password) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Admin login — constant-time comparison to prevent timing attacks
      if (login === "admin") {
        const env = loadAppEnv();
        const adminBuf = Buffer.from(env.adminPassword);
        const inputBuf = Buffer.from(password);
        if (adminBuf.length === inputBuf.length && crypto.timingSafeEqual(adminBuf, inputBuf)) {
          const token = signToken("admin", "admin");
          return res.json({ token });
        }
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Editor login
      const user = userRepo.findByLogin(login);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      if (user.disabled) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const validPassword = await userService.comparePassword(password, user.hashed_password);
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = signToken(user.login, "editor");
      res.json({ token });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Logout requires auth
  router.post("/logout", requireAuthMiddleware, (_req: Request, res: Response) => {
    res.status(204).send();
  });

  // Me requires auth
  router.get("/me", requireAuthMiddleware, (req: Request, res: Response) => {
    const authReq = req as { user?: { login: string; role: string } };
    if (!authReq.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    res.json({ login: authReq.user.login, role: authReq.user.role });
  });

  return router;
}
