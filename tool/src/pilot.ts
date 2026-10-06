import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { survey, profiles, config } from "./fixtures.js";
import { run } from "./runner.js";
import { evaluate } from "./evaluate.js";
const out = process.argv[2] ?? "runs/technical-pilot";
const p = profiles();
await mkdir(out, { recursive: true });
for (const [file, value] of Object.entries({
  "survey.json": survey,
  "profiles.json": p,
  "config.json": config,
}))
  await writeFile(join(out, file), JSON.stringify(value, null, 2));
const base = await run(survey, p, config, join(out, "base"), "dev", 50);
const resumed = await run(survey, p, config, join(out, "base"), "dev", 50);
const variant = await run(
  survey,
  p,
  { ...config, promptVariant: "paraphrase" },
  join(out, "paraphrase"),
  "dev",
  50,
);
const truth = p
  .filter((x) => x.split === "dev")
  .flatMap((x, i) =>
    survey.questions.map((q, j) => ({
      profile: x.id,
      question: q.id,
      answer: q.options[(i + j) % q.options.length].code,
      weight: x.weight,
    })),
  );
await writeFile(join(out, "fixture-truth.json"), JSON.stringify(truth, null, 2));
const rows = (await readFile(join(out, "base/responses.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((x) => JSON.parse(x));
const metrics = evaluate(rows, truth, survey);
await writeFile(
  join(out, "fixture-metrics.json"),
  JSON.stringify(metrics, null, 2),
);
const report = {
  scope: "TECHNICAL FIXTURE ONLY. No human or LLM fidelity evidence.",
  base,
  resumed,
  paraphrase: variant,
  repeatCallsAdded: resumed.calls - base.calls,
  metricCells: metrics.length,
  apiCostUsd: 0,
};
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
