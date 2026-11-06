## Summary

<!-- 1-3 bullets: what changed and why. Link the ticket. -->

## Changes

<!-- Per-service breakdown if multi-service. Note any new entities, queues, env vars, or message patterns. -->

## Test plan

- [ ] `pnpm exec tsc --noEmit` clean
- [ ] `pnpm run lint`
- [ ] `pnpm run test` — unit suite green
- [ ] Bootstrap specs green (`pnpm exec jest --testPathPattern=".module.bootstrap.spec.ts$"`)
- [ ] Manually verified the golden path locally

## Module / DI checklist

Touched any `*.module.ts`, added an `@InjectRepository`, or added a new `ClientProxy` injection? Confirm:

- [ ] Any new entity is added to `DatabaseModule.forRoot({ entities: [...] })` in the consuming service's root module
- [ ] Any new `@InjectRepository(X)` has `X` registered as an entity in that service
- [ ] Any new `@Inject('SCRIPT_PARSER_SERVICE' | CORE_SERVICE | AI_SERVICE | ...)` has matching `ClientsModule.registerAsync` in the consuming submodule (parent registrations do NOT propagate into child modules)
- [ ] Booted the affected service(s) locally end-to-end — not just typecheck — if module wiring crosses service boundaries
- [ ] Cross-service consumers/producers (RMQ patterns, queues) have both sides wired and confirmed via boot logs

## Migrations / data

- [ ] N/A, OR migration added under `migrations/` and rollout plan noted

## Risk / rollback

<!-- What breaks if this is wrong? How do we roll back? -->
