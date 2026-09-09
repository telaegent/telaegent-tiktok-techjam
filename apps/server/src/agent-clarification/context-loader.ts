import { z } from "zod";
import { SupabaseRpcTransport } from "../supabase-rpc-transport.js";

const contextSchema = z.strictObject({
  taskId: z.string().uuid(),
  requesterName: z.string().min(1).max(80),
  responderName: z.string().min(1).max(80),
  sharedHistory: z.array(z.strictObject({
    messageId: z.string().uuid(),
    authorUserId: z.string().uuid(),
    authorName: z.string().min(1).max(80),
    text: z.string().min(1).max(50_000),
    sentAt: z.string().datetime({ offset: true }),
  })).max(200),
});

export type AgentClarificationContext = z.infer<typeof contextSchema>;

export interface AgentClarificationContextLoader {
  load(input: Readonly<{
    taskId: string;
    actorUserId: string;
  }>): Promise<AgentClarificationContext | null>;
}

export class SupabaseAgentClarificationContextLoader
  implements AgentClarificationContextLoader
{
  private readonly transport: SupabaseRpcTransport;

  constructor(
    supabaseUrl: string,
    secretKey: string,
    fetchImplementation?: typeof fetch,
  ) {
    this.transport = new SupabaseRpcTransport({
      supabaseUrl,
      secretKey,
      maximumResponseBytes: 2_097_152,
      ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
    });
  }

  async load(input: Readonly<{
    taskId: string;
    actorUserId: string;
  }>): Promise<AgentClarificationContext | null> {
    const value = await this.transport.call("load_agent_clarification_context", {
      p_task_id: input.taskId,
      p_actor_user_id: input.actorUserId,
      p_message_limit: 200,
    });
    if (value === null) return null;
    const parsed = contextSchema.safeParse(value);
    if (!parsed.success) throw new Error("Agent clarification context is invalid");
    return parsed.data;
  }
}
