import { z } from 'zod';

export const loginSchema = {
  body: z.object({
    username: z.string().trim().min(1, 'Username is required.').max(100),
    // Not trimmed: passwords may legitimately contain leading/trailing spaces.
    password: z.string().min(1, 'Password is required.').max(200),
  }),
};

export type LoginBody = z.infer<typeof loginSchema.body>;
