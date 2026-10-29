import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const base = dirname(fileURLToPath(import.meta.url));
const fixed = process.argv.includes("--fixed");
const sourceIndex = process.argv.indexOf("--source");
const source = sourceIndex === -1 ? join(base, fixed ? "schedule-fix" : "source") : resolve(process.argv[sourceIndex + 1]);
const sandbox = join(base, ".tmp-sandbox-schedule");
const sha = "51f63e4fd63aeeb74d708b9c3d1f8b800aff9b3e";
if (fixed) {
  execFileSync("git", ["-C", source, "merge-base", "--is-ancestor", sha, "HEAD"]);
} else {
  assert.equal(execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sha);
}
assert.equal(existsSync(sandbox), false, `Sandbox already exists: ${sandbox}`);

const copied = {
  "cron/runner/cron-runner.ts": "core/src/cron/runner/cron-runner.ts",
  "cron/runner/cron-materializer.ts": "core/src/cron/runner/cron-materializer.ts",
  "cron/store/sqlite-cron-store.ts": "core/src/cron/store/sqlite-cron-store.ts",
  "cron/store/cron-schema.ts": "core/src/cron/store/cron-schema.ts",
  "cron/schedule/scheduler.ts": "core/src/cron/schedule/scheduler.ts",
  "cron/service/schedule-service.ts": "core/src/cron/service/schedule-service.ts",
  "shared/db/sqlite-db.ts": "shared/src/db/sqlite-db.ts",
  "shared/parse/error.ts": "shared/src/parse/error.ts",
};
const generated = {
  "package.json": '{"type":"module"}',
  "shared/index.ts": `export const ONE_TIME_SCHEDULE_CRON_PATTERN = "0";
export const ONE_TIME_SCHEDULE_RUN_AT_METADATA_KEY = "__hubScheduleRunAt";
export function buildClineSystemPrompt() { return "test prompt"; }`,
  "shared/storage.ts": `export function resolveCronDbPath() { throw new Error("dbPath required in test"); }`,
  "extensions/tools/constants.ts": `export const DefaultToolNames = { ASK: "ask", SUBMIT_AND_EXIT: "submit_and_exit" };`,
  "runtime/safety/rules.ts": `export function mergeRulesForSystemPrompt(a, b) { return a ?? b; }`,
  "services/telemetry/core-events.ts": `export function captureScheduleRun() {}`,
  "services/workspace/workspace-manifest.ts": `export async function buildWorkspaceMetadata() { return {}; }`,
  "cron/reports/cron-report-writer.ts": `export function writeCronRunReport() { return undefined; }`,
  "loader.mjs": `const shared = {
  "@cline/shared": "./shared/index.ts",
  "@cline/shared/db": "./shared/db/sqlite-db.ts",
  "@cline/shared/storage": "./shared/storage.ts"
};
export async function resolve(specifier, context, nextResolve) {
  if (shared[specifier]) return { url: new URL(shared[specifier], import.meta.url).href, shortCircuit: true };
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(specifier + ".ts", context);
    throw error;
  }
}`,
  "test.mts": `import assert from "node:assert/strict";
import { HubScheduleService } from "./cron/service/schedule-service.ts";
const NativeDate = Date;
let simulatedNow = NativeDate.parse("2026-11-01T05:29:00.000Z");
class SimulatedDate extends NativeDate {
  constructor(...args) { if (args.length === 0) super(simulatedNow); else super(...args); }
  static now() { return simulatedNow; }
}
globalThis.Date = SimulatedDate;
const sent = [];
const runtimeHandlers = {
  async startSession() { return { sessionId: "session-" + (sent.length + 1) }; },
  async sendSession(sessionId, request) { sent.push({ sessionId, prompt: request.prompt }); return { result: { text: "ok" } }; },
  async abortSession() { return { applied: true }; },
  async stopSession() { return { applied: true }; }
};
const svc = new HubScheduleService({ runtimeHandlers, dbPath: "./test.db", specs: { scope: "workspace", workspaceRoot: process.cwd() } });
try {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York");
  const created = svc.createSchedule({ name: "UTC routine", cronPattern: "30 6 * * *", timezone: "UTC", prompt: "do work", workspaceRoot: process.cwd() });
  const before = new NativeDate(created.nextRunAt).toISOString();
  const records = [];
  for (const stamp of ["2026-11-01T06:30:00.000Z", "2026-11-01T06:30:15.000Z", "2026-11-01T06:30:30.000Z"]) {
    simulatedNow = NativeDate.parse(stamp);
    await svc.runner.tick();
    const current = svc.getSchedule(created.scheduleId);
    records.push({ now: stamp, nextRunAt: new NativeDate(current.nextRunAt).toISOString(), sent: sent.length });
  }
  const executions = svc.listScheduleExecutions({ scheduleId: created.scheduleId, limit: 20 });
  console.log(JSON.stringify({ before, records, sent: sent.length, runs: executions.map(x => ({ status: x.status, triggeredAt: new NativeDate(x.triggeredAt).toISOString() })) }));
  assert.equal(before, "2026-11-01T06:30:00.000Z");
  assert.equal(sent.length, ${fixed ? 1 : 3});
  assert.equal(executions.length, ${fixed ? 1 : 3});
  ${fixed ? 'assert.ok(records.every(x => x.nextRunAt === "2026-11-02T06:30:00.000Z"));' : ''}
  assert.ok(executions.every(x => x.status === "success"));
  assert.ok(executions.every(x => new NativeDate(x.triggeredAt).toISOString() === before));
} finally {
  await svc.dispose();
  globalThis.Date = NativeDate;
}`,
};

const directories = new Set();
function target(relative) {
  const path = resolve(sandbox, relative);
  assert.ok(path.startsWith(sandbox + sep), `Unexpected path: ${path}`);
  return path;
}
function parentDirectories(relative) {
  let path = dirname(target(relative));
  while (path !== sandbox) {
    assert.ok(path.startsWith(sandbox + sep));
    directories.add(path);
    path = dirname(path);
  }
  mkdirSync(dirname(target(relative)), { recursive: true });
}

mkdirSync(sandbox);
try {
  for (const [destination, original] of Object.entries(copied)) {
    parentDirectories(destination);
    copyFileSync(join(source, "sdk", "packages", original), target(destination));
  }
  for (const [destination, content] of Object.entries(generated)) {
    parentDirectories(destination);
    writeFileSync(target(destination), content);
  }
  const env = {
    TZ: "America/New_York",
    NODE_OPTIONS: "--max-old-space-size=256",
    SystemRoot: process.env.SystemRoot,
    TEMP: sandbox,
    TMP: sandbox,
  };
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--loader", "./loader.mjs", "test.mts"], {
    cwd: sandbox, env, encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Child exited with status ${result.status}`);
} finally {
  for (const file of [...Object.keys(copied), ...Object.keys(generated), "test.db", "test.db-wal", "test.db-shm"]) {
    const path = target(file);
    if (existsSync(path)) unlinkSync(path);
  }
  for (const path of [...directories].sort((a, b) => b.length - a.length)) rmdirSync(path);
  rmdirSync(sandbox);
}
