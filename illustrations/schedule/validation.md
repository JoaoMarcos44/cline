# Duplicate scheduled runs during the host's DST fallback

At commit `51f63e4fd63aeeb74d708b9c3d1f8b800aff9b3e`, a recurring schedule can start the same occurrence on every scheduler poll during the repeated local hour after a daylight-saving transition. This happens even when the schedule explicitly uses `UTC`.

## Observed behavior

With the host timezone set to `America/New_York`, a daily `30 6 * * *` schedule in `UTC` is due at `2026-11-01T06:30:00Z`, during the second local 01:30. Three ticks at 06:30:00, 06:30:15 and 06:30:30 sent three separate agent turns. All three completed successfully with the same scheduled occurrence, and `nextRunAt` remained 06:30:00 throughout. The expected result is one turn for this UTC occurrence, with the next occurrence on the following day.

The reproduction uses the real `HubScheduleService`, `CronRunner`, `CronMaterializer`, scheduler, SQLite store and schema from the commit. The runtime handlers return a successful fake agent result. Prompt construction, report writing, telemetry, workspace metadata and tool-name constants are replaced with small stubs. The test uses a simulated clock and a real isolated SQLite database; it does not contact a provider or perform external actions.

## Root cause

Both scheduler paths round using `Date.setSeconds(0, 0)` on a local `Date`. During the second instance of an ambiguous local time, this setter can choose the earlier instance and move the timestamp back one hour. In the explicit-timezone path this happens before scanning the requested timezone, so the bug is governed by the scheduler host's timezone even if the schedule timezone is UTC. See [scheduler.ts:257](https://github.com/cline/cline/blob/51f63e4fd63aeeb74d708b9c3d1f8b800aff9b3e/sdk/packages/core/src/cron/schedule/scheduler.ts#L257) and [scheduler.ts:289](https://github.com/cline/cline/blob/51f63e4fd63aeeb74d708b9c3d1f8b800aff9b3e/sdk/packages/core/src/cron/schedule/scheduler.ts#L289).

For the tested input, the subsequent scan returns 06:30 again instead of a future time. The store writes that timestamp as `next_run_at` after queuing the due occurrence, so the next tick considers it due again. See [sqlite-cron-store.ts:1216](https://github.com/cline/cline/blob/51f63e4fd63aeeb74d708b9c3d1f8b800aff9b3e/sdk/packages/core/src/cron/store/sqlite-cron-store.ts#L1216) and [cron-runner.ts:255](https://github.com/cline/cline/blob/51f63e4fd63aeeb74d708b9c3d1f8b800aff9b3e/sdk/packages/core/src/cron/runner/cron-runner.ts#L255). The default polling interval is 15 seconds. More repeated runs are possible while the returned time remains in the past, depending on execution duration and configured capacity. The reproduction establishes three runs, not a measured upper bound.

## Reproduction

Prerequisites are Node.js 22.16.0 or a compatible Node version supporting `node:sqlite` and `--experimental-strip-types`, Git, and a checkout at `source` pinned to the commit above. The script rejects a different checkout SHA and refuses to use an existing sandbox. It copies the source into `.tmp-sandbox-schedule`, runs one worker with a 256 MB Node heap limit, and removes its generated files and sandbox after completion.

From `C:\Users\Nitro\cline-functional-audit`:

```powershell
node --max-old-space-size=256 schedule-repro.mjs
```

Exit code: `0`. Complete output:

```json
{"before":"2026-11-01T06:30:00.000Z","records":[{"now":"2026-11-01T06:30:00.000Z","nextRunAt":"2026-11-01T06:30:00.000Z","sent":1},{"now":"2026-11-01T06:30:15.000Z","nextRunAt":"2026-11-01T06:30:00.000Z","sent":2},{"now":"2026-11-01T06:30:30.000Z","nextRunAt":"2026-11-01T06:30:00.000Z","sent":3}],"sent":3,"runs":[{"status":"success","triggeredAt":"2026-11-01T06:30:00.000Z"},{"status":"success","triggeredAt":"2026-11-01T06:30:00.000Z"},{"status":"success","triggeredAt":"2026-11-01T06:30:00.000Z"}]}
```

An earlier direct scheduler check at `2026-11-01T06:00:00Z` with `TZ=America/New_York` and pattern `30 1 * * *` returned `2026-11-01T05:30:00Z` for both an omitted timezone and explicit `America/New_York`, which is before the supplied time. The initial comparison incorrectly expected the explicit-timezone path to avoid the bug; the observed result disproved that assumption.

## Duplicate search

GitHub issue searches without a state restriction covered `cron` with `DST`, `daylight`, `duplicate`, `repeated`, `past` and `timezone`, plus `setSeconds`, `getNextCronTime`, `repeated hour`, and `ambiguous timezone`. No matching DST fallback defect was found. Pull-request searches covered both open and closed PRs using `DST`, `daylight saving`, `fall back`, `ambiguous time`, `repeated hour`, `cron duplicate`, `cron repeated`, and `cron past`.

[PR #14004](https://github.com/cline/cline/pull/14004) was merged and addresses repeated sessions from lease/poll ordering and default timezone selection, but its described cases do not cover a local `Date.setSeconds` moving the next occurrence into the past. [PR #13745](https://github.com/cline/cline/pull/13745) is open and addresses an expired run lease after system sleep, a different mechanism. Search results do not prove that no unindexed or differently described report exists.

An unrelated day-of-month/day-of-week matching defect already has [PR #14541](https://github.com/cline/cline/pull/14541), and Sunday value `7` already has [issue #15245](https://github.com/cline/cline/issues/15245).

## Fix and validation

The fix subtracts elapsed seconds and milliseconds without a local Date setter, then advances forward and projects each candidate into the requested or local timezone. It removes the local hour and minute jumps that could move backward or skip a repeated occurrence. On days whose calendar fields cannot match, local schedules can skip to the next day when the jump advances time and the UTC offset is unchanged. Days with a changing offset continue minute by minute. The initial local minute boundary and the existing local four-year search horizon are preserved.

The committed RED suite had eight intended failures and five passes. The final focused suite passed all 20 tests with Vitest 4.0.18. The cases cover both New York occurrences, explicit UTC, implicit local time, the spring gap, a weekly schedule, Kathmandu's fractional offset, Lord Howe's 30-minute fold, an annual schedule, an impossible date, Casey's return to the previous calendar day, Moscow's offset change at the four-year horizon, and Monrovia's historical offset in seconds. TypeScript 5.9.3 strict checks, Biome 2.4.5, the Bun bundle, and `git diff --check` passed. Tests transpile the actual scheduler source for child processes, so they do not require the Node 22.6 type-stripping feature. The child uses the test process's executable rather than resolving Node through PATH.

The integrated reproduction was rerun on the final source with `node --max-old-space-size=256 schedule-repro.mjs --fixed`. It exited with code 0 and produced:

```json
{"before":"2026-11-01T06:30:00.000Z","records":[{"now":"2026-11-01T06:30:00.000Z","nextRunAt":"2026-11-02T06:30:00.000Z","sent":1},{"now":"2026-11-01T06:30:15.000Z","nextRunAt":"2026-11-02T06:30:00.000Z","sent":1},{"now":"2026-11-01T06:30:30.000Z","nextRunAt":"2026-11-02T06:30:00.000Z","sent":1}],"sent":1,"runs":[{"status":"success","triggeredAt":"2026-11-01T06:30:00.000Z"}]}
```

To use the reproduction with a checkout in a different directory, pass `--source <checkout>`. Use the baseline commit without `--fixed`, or the fix branch with `--fixed`. The standalone reproduction requires Node 22.16.0 or a compatible runtime with SQLite and type stripping. It stubs prompt/report/telemetry integrations but retains the real scheduler, queue, runner and SQLite implementations. The persisted fold reproduction is a standalone artifact, while the committed automated regression suite covers scheduler outputs.

Functional priority is high, P1, because a routine can repeatedly start tasks and model calls for the same occurrence without a user action. The trigger requires a matching occurrence during a backward transition in the host timezone. The output proves three repeated runs, not an upper bound.

Issue: https://github.com/cline/cline/issues/15418

The RED and initial fix commits are `11c05b2d3ee28c94888353bce2f9d56e5ad0b7e1` and `9a7fb5461453cf40225357a82e94c3237a3bf953`. Review corrections are in `1752f2f5784157e724af46a408a67d5ff2ad618d`. Tests ran with Node 22.16.0 and Bun 1.3.11, which differs from the repository's requested Bun 1.4.2. Full monorepo and application builds were not run. The Poteto principles Fix Root Causes and Prove It Works led to replacing unsafe local-time advancement and checking the persisted next timestamp with the actual service.
