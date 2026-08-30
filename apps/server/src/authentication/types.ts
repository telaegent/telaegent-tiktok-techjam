import { z } from "zod";

export const telaegentWebUserSchema = z
  .object({
    userId: z.string().uuid(),
    githubUserId: z.string().regex(/^[1-9]\d{0,18}$/),
    githubLogin: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
    avatarUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => value.startsWith("https://"))
      .nullable(),
  })
  .strict();

export type TelaegentWebUser = z.infer<typeof telaegentWebUserSchema>;

export class UserAuthenticationError extends Error {
  readonly code:
    | "AUTHENTICATION_REQUIRED"
    | "AUTHENTICATION_FAILED"
    | "AUTHENTICATION_UNAVAILABLE";
  readonly statusCode: 401 | 503;
  readonly retryable: boolean;

  constructor(
    code: UserAuthenticationError["code"],
    message: string,
    statusCode: UserAuthenticationError["statusCode"] = 401,
  ) {
    super(message);
    this.name = "UserAuthenticationError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = statusCode === 503;
  }
}
