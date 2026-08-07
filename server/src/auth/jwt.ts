import jwt from "jsonwebtoken";
import { loadAppEnv } from "../config/env";

export interface JwtPayload {
  sub: string;
  role: "admin" | "editor";
  iat: number;
  exp: number;
}

const EXPIRY_HOURS = 8;

export function signToken(login: string, role: "admin" | "editor"): string {
  const env = loadAppEnv();
  const payload: Omit<JwtPayload, "iat" | "exp"> = { sub: login, role };
  return jwt.sign(payload, env.jwtSecret, { algorithm: "HS256", expiresIn: `${EXPIRY_HOURS}h` });
}

export function verifyToken(token: string): JwtPayload {
  const env = loadAppEnv();
  return jwt.verify(token, env.jwtSecret) as JwtPayload;
}
