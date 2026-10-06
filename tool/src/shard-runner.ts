import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hash } from "./schema.js";

const { values } = parseArgs({
  options: {
    survey: { type: "string" },
    profiles: { type: "string" },
    config: { type: "string" },
    out: { type: "string" },
    workers: { type: "string", default: "8" },
    split: { type: "string", default: "test" },
  },
});
for (const [key, value] of Object.entries(values))
  if (key !== "workers" && key !== "split" && !value)
    throw new Error(`--${key} is required`);
if (values.split !== "test") throw new Error("Shard runner only supports test");
const workers = Number(values.workers);
if (!Number.isSafeInteger(workers) || workers < 1 || workers > 32)
  throw new Error("--workers must be an integer from 1 to 32");

const [survey, profiles, config] = await Promise.all([
  readFile(values.survey!, "utf8").then(JSON.parse),
  readFile(values.profiles!, "utf8").then(JSON.parse),
  readFile(values.config!, "utf8").then(JSON.parse),
]);
if (
  config.budget &&
  config.models.some((model: any) => model.provider !== "mock")
)
  throw new Error(
    "Sharded live runs would multiply the per-run budget; use the sequential CLI until a shared budget ledger exists",
  );
const targetProfiles = profiles
  .filter((p: any) => p.split === "test")
  .sort((a: any, b: any) =>
    hash(`${config.seed}:${a.id}`).localeCompare(
      hash(`${config.seed}:${b.id}`),
    ),
  );
if (!targetProfiles.length) throw new Error("No test profiles in input");
const shardSize = Math.ceil(targetProfiles.length / workers);
const shards = Array.from(
  { length: Math.ceil(targetProfiles.length / shardSize) },
  (_, i) => ({
    index: i,
    offset: i * shardSize,
    count: Math.min(shardSize, targetProfiles.length - i * shardSize),
  }),
);
const out = values.out!;
await mkdir(out, { recursive: true });
try {
  await readFile(join(out, "manifest.json"));
  throw new Error("Output already contains a manifest; choose a new directory");
} catch (error: any) {
  if (error.code !== "ENOENT") throw error;
}
const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
const active = new Set<ReturnType<typeof spawn>>();
function stopActive() {
  for (const child of active) child.kill("SIGTERM");
}

async function execute(shard: (typeof shards)[number]) {
  const shardOut = join(
    out,
    `shard-${String(shard.index + 1).padStart(2, "0")}`,
  );
  const args = [
    cli,
    "run",
    "--survey",
    values.survey!,
    "--profiles",
    values.profiles!,
    "--config",
    values.config!,
    "--out",
    shardOut,
    "--split",
    "test",
    "--count",
    String(shard.count),
    "--offset",
    String(shard.offset),
  ];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    active.add(child);
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part) => (stdout += part));
    child.stderr.setEncoding("utf8").on("data", (part) => (stderr += part));
    child.on("error", (error) => {
      active.delete(child);
      stopActive();
      reject(error);
    });
    child.on("close", (code) => {
      active.delete(child);
      if (code === 0) resolve(stdout);
      else {
        stopActive();
        reject(
          new Error(
            `Shard ${shard.index + 1} exited ${code}: ${stderr.slice(-1000)}`,
          ),
        );
      }
    });
  });
  try {
    const summary = JSON.parse(output);
    if (!summary.complete || summary.completedJobs !== summary.plannedJobs)
      throw new Error(
        `Shard ${shard.index + 1} incomplete: ${JSON.stringify(summary)}`,
      );
    const manifest = JSON.parse(
      await readFile(join(shardOut, "manifest.json"), "utf8"),
    );
    return { ...shard, summary, manifest };
  } catch (error) {
    stopActive();
    throw error;
  }
}

const shardResults = await Promise.all(shards.map(execute));
const responseParts = await Promise.all(
  shardResults.map((shard) =>
    readFile(
      join(
        out,
        `shard-${String(shard.index + 1).padStart(2, "0")}`,
        "responses.jsonl",
      ),
      "utf8",
    ),
  ),
);
const rows = responseParts.flatMap((part) =>
  part
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line)),
);
const expectedJobs =
  targetProfiles.length *
  survey.questions.length *
  config.conditions.length *
  config.models.length *
  config.replicates;
if (
  rows.length !== expectedJobs ||
  new Set(rows.map((row: any) => row.job)).size !== rows.length
)
  throw new Error(
    `Aggregate grid is incomplete or duplicated: ${rows.length}/${expectedJobs}`,
  );

const manifest = {
  engine: shardResults[0].manifest.engine,
  fingerprint: hash(shardResults.map((shard) => shard.manifest.fingerprint)),
  split: "test",
  count: targetProfiles.length,
  plannedJobs: expectedJobs,
  technicalOnly: config.models.every((model: any) => model.provider === "mock"),
  config,
  createdAt: new Date().toISOString(),
  shards: shardResults.map(({ index, offset, count, manifest: m }) => ({
    index,
    offset,
    count,
    fingerprint: m.fingerprint,
  })),
};
await writeFile(
  join(out, "responses.jsonl"),
  rows.map((row: any) => JSON.stringify(row)).join("\n") + "\n",
);
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
await writeFile(
  join(out, "shards-summary.json"),
  JSON.stringify(
    shardResults.map((s) => ({
      ...s.summary,
      offset: s.offset,
      count: s.count,
    })),
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      complete: true,
      profiles: targetProfiles.length,
      shards: shards.length,
      plannedJobs: expectedJobs,
      actualRows: rows.length,
    },
    null,
    2,
  ),
);
