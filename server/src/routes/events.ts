import { Router, Request, Response } from "express";
import type { EventsEmitter, RealtimeEvent } from "../services/events";
import type { AuthRequest } from "../auth/requireAuth";

export function createEventsRouter(emitter: EventsEmitter): Router {
  const router: Router = Router();

  // Bearer-guarded at mount time (requireAuth in app.ts). The client reads the
  // stream with a fetch body reader because EventSource cannot set headers.
  router.get("/", (req: Request, res: Response) => {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const send = (event: RealtimeEvent): void => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = emitter.subscribe(null, send);

    // Close the stream when the bearer token expires so the client reconnects,
    // hits a 401, and drops to the login screen.
    const { exp } = (req as AuthRequest).user;
    const expiryTimer = setTimeout(() => {
      if (!res.writableEnded) res.end();
    }, Math.max(0, exp * 1000 - Date.now()));

    req.on("close", () => {
      unsubscribe();
      clearTimeout(expiryTimer);
      res.end();
    });
  });

  return router;
}
