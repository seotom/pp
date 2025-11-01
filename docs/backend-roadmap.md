# Backend Roadmap

Planned milestones for completing the AI nutrition assistant pipeline.

## Immediate Next Steps

1. **Parser & Intent Analyzer**
   - Finalize prompt assembly in `@/modules/prompt-builder`.
   - Implement OpenAI call inside `@/modules/intent-analyzer` using GPT-4o-mini with JSON mode.
   - Define shared intent types to replace `unknown`.

2. **Entity Resolver**
   - Load family members via Supabase and reconcile `target_scope`, pronouns, and named entities.
   - Provide fallback logic for `pending_clarification` when resolution fails.

3. **Clarification Handler**
   - Persist clarification requests inside `profiles.family_data`.
   - Implement timeouts and merge logic for queued clarifications.

4. **Update Applier**
   - Wrap Supabase writes in transactions where possible.
   - Update `profiles` and `family_members`, returning formatted summaries for the API response.

5. **Authentication**
   - Expose API endpoints or server actions to start Google OAuth via Supabase (`createGoogleSignInUrl`).
   - Validate Supabase sessions on server routes before processing updates.

6. **Testing**
   - Add module-level unit tests (e.g., using Vitest) for parsing, clarification, and canonicalization.
   - Stub OpenAI and Supabase in tests for deterministic pipelines.

## Infra / DevEx

- Document required environment variables in `.env.example`.
- Consider scaffolding Prisma schema to mirror Supabase tables for type-safe queries.
- Add OpenAI rate limiting and logging middleware once endpoints stabilize.
