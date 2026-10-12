# Local draft MR

## Title

Fix Swarm coordination boundaries and recipient validation

## Summary

- Add manager/worker prompt rules for automatic runtime notifications, coordination after child turns, Task ownership, Activity granularity, and Paseo-vs-harness agent boundaries.
- Validate Swarm message recipients against active roster identity, qualified name, and Task membership.
- Add regression coverage for recipient mismatch, unknown recipients, and non-member recipients.

## Validation

- `npm --prefix plugins/paseo-swarm run typecheck`
- `npm run typecheck`
- targeted `npm run lint -- ...`
- `npm run format:check`
- `git diff --check`
- `node --import tsx --test paseo-swarm/test/operations.test.ts`

The full plugin suite was not run. Direct Vitest invocation was unsuitable for these Node test files and reported no test suite.

## Risks and follow-up

- Direct plugin RPC principal binding remains an identified static risk and needs a separate authorization design.
- Roster retirement/re-enable lifecycle remains unimplemented.
- Notification coverage for idle and provider-specific exits needs runtime integration tests.
