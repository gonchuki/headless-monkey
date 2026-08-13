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

function validatePayloadShape(payload: unknown): asserts payload is JwtPayload {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Invalid token payload");
  }

  if (typeof (payload as Record<string, unknown>).sub !== "string") {
    throw new Error("Invalid token payload: sub must be a string");
  }

  const role = (payload as Record<string, unknown>).role;
  if (role !== "admin" && role !== "editor") {
    throw new Error("Invalid token payload: role must be admin or editor");
  }

  if (typeof (payload as Record<string, unknown>).exp !== "number" || !Number.isFinite((payload as Record<string, unknown>).exp)) {
    throw new Error("Invalid token payload: exp must be a finite number");
  }
}

export function verifyToken(token: string): JwtPayload {
  const env = loadAppEnv();
  const decoded = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
  validatePayloadShape(decoded);
  return decoded as JwtPayload;
}
