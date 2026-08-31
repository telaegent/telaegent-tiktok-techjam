import type { FastifyReply } from "fastify";

/** Prevent browsers and intermediaries from retaining owner-private responses. */
export function setPrivateNoStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store, max-age=0");
  reply.header("pragma", "no-cache");
}
