import { z } from 'zod';

/** Messages are translation KEYS under "validation" (the UI translates them). */
export const loginFormSchema = z.object({
  email: z.string().trim().min(1, 'required').pipe(z.email('email')),
  password: z.string().min(1, 'required').max(200, 'maxLength'),
});
export type LoginFormValues = z.infer<typeof loginFormSchema>;
