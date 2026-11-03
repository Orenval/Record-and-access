// =============================================================================
// Validation Schemas (Zod) — Single Source of Truth
// =============================================================================
// Requirement 1: Password rules defined here, not scattered across endpoints.
// Requirement 2: This file is imported by BOTH API route handlers (server-side,
// the authoritative check) AND client-side form components (for inline UX
// feedback). Client-side validation is a convenience — never the only check.

import { z } from "zod";

// -----------------------------------------------------------------------------
// Password strength rules
// -----------------------------------------------------------------------------
// Minimum 12 characters, at least one of each: uppercase, lowercase, digit,
// special character. Each rule is a separate regex for clear error messages.
//
// Why separate regexes instead of one combined pattern?
// → Allows us to return specific feedback ("missing uppercase") rather than a
//   generic "invalid password" message, which improves usability without
//   weakening security (the rules are public knowledge anyway).

const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .regex(/[A-Z]/, "Password must include at least one uppercase letter")
  .regex(/[a-z]/, "Password must include at least one lowercase letter")
  .regex(/[0-9]/, "Password must include at least one number")
  .regex(
    /[^A-Za-z0-9]/,
    "Password must include at least one special character"
  );

// Individual password rule checkers — use these in the UI checklist so we
// never duplicate the regex logic defined above.
export type PasswordRule = {
  id: string;
  label: string;
  test: (pw: string) => boolean;
};

export const passwordRules: PasswordRule[] = [
  { id: "length",  label: "At least 12 characters",       test: (pw) => pw.length >= 12 },
  { id: "upper",   label: "At least one uppercase letter", test: (pw) => /[A-Z]/.test(pw) },
  { id: "lower",   label: "At least one lowercase letter", test: (pw) => /[a-z]/.test(pw) },
  { id: "number",  label: "At least one number",           test: (pw) => /[0-9]/.test(pw) },
  { id: "special", label: "At least one special character", test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

// -----------------------------------------------------------------------------
// Full name rule
// -----------------------------------------------------------------------------
// Must contain at least two words (reject single-word names like "Madonna").
// We trim, then split on whitespace and filter empties.

const fullNameSchema = z
  .string()
  .trim()
  .refine(
    (val) => val.split(/\s+/).filter((word) => word.length > 0).length >= 2,
    { message: "Full name must contain at least two words (e.g. first and last name)" }
  );

// -----------------------------------------------------------------------------
// Exported schemas
// -----------------------------------------------------------------------------

export const signInSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  // No strength validation on sign-in — we only check that a password was
  // provided.
  password: z.string().min(1, "Password is required"),
});

// Re-export types for use in form components
export type SignInInput = z.infer<typeof signInSchema>;
