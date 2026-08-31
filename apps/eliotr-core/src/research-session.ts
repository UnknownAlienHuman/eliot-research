import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";

export class ResearchSession extends DurableObject<Env> {
  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json({
        protocol: "eliotr.research-session.v1",
        state: "IMPLEMENTATION_PENDING",
        persisted_state_authoritative: false,
        durable_copy_location: "D1 Core + R2 checkpoints",
      }, { status: 503 });
    }
    return Response.json({ code: "SESSION_IMPLEMENTATION_PENDING" }, { status: 501 });
  }
}
