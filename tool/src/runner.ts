import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  open,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "csv-stringify/sync";
import {
  check,
  hash,
  validateConfig,
  validateProfiles,
  validateSurvey,
  type Profile,
  type RunConfig,
  type Survey,
} from "./schema.js";
import { type TrainMarginalCalibration } from "./calibration.js";
import { context, donors, prompt } from "./context.js";
import { respond, parseAnswer, ProviderError } from "./providers.js";
export const ENGINE_VERSION = "0.3.0";
export interface RecordRow {
  job: string;
  profile: string;
  question: string;
  condition: string;
  model: string;
  replicate: number;
  answer: string;
  status: string;
  weight: number;
  psu: string;
  attempts: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  synthetic: true;
  provider: string;
  promptHash: string;
  promptVariant?: string;
  resolvedModel: string;
}
function pricedUsd(input: number, output: number, cfg: RunConfig) {
  if (!cfg.budget) return 0;
  return (
    (input * cfg.budget.inputUsdPerMillion +
      output * cfg.budget.outputUsdPerMillion) /
    1_000_000
  );
}
function reserveUsd(
  messages: { system: string; user: string },
  maxOutputTokens: number,
  cfg: RunConfig,
) {
  // UTF-8 bytes plus an overhead allowance conservatively approximate input tokens.
  return pricedUsd(
    Buffer.byteLength(messages.system) +
      Buffer.byteLength(messages.user) +
      1024,
    maxOutputTokens,
    cfg,
  );
}
async function readLines(path: string): Promise<any[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw new Error(`Cannot resume corrupt journal: ${path}`);
  }
}
export async function run(
  surveyInput: Survey,
  profilesInput: Profile[],
  cfgInput: RunConfig,
  out: string,
  split: "dev" | "test" = "dev",
  n?: number,
  provider = respond,
  offset = 0,
  calibration?: TrainMarginalCalibration,
) {
  const survey = validateSurvey(surveyInput),
    profiles = validateProfiles(profilesInput, survey),
    cfg = validateConfig(cfgInput);
  if (cfg.conditions.includes("D+C+marginal"))
    check(calibration !== undefined, "Training marginal calibration required");
  if (
    cfg.promptVariant === "response_aware" ||
    cfg.promptVariant === "response_calibrated"
  )
    check(
      survey.questions.every(
        (q) =>
          q.options.some((o) => o.role === "dont_know") &&
          q.options.some((o) => o.role === "no_answer") &&
          q.options.some(
            (o) => o.role === undefined || o.role === "substantive",
          ),
      ),
      "response_aware requires substantive, dont_know and no_answer roles on every item",
    );
  if (cfg.promptVariant === "response_calibrated")
    check(
      cfg.conditions.every((condition) => condition === "D+C+marginal"),
      "response_calibrated requires only the D+C+marginal condition",
    );
  const train = profiles.filter((p) => p.split === "train");
  if (cfg.conditions.includes("D+C-group"))
    check(train.length > 0, "Training profiles required for group condition");
  const pool = profiles
    .filter((p) => p.split === split)
    .sort((a, b) =>
      hash(`${cfg.seed}:${a.id}`).localeCompare(hash(`${cfg.seed}:${b.id}`)),
    );
  const count = n ?? pool.length;
  check(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      Number.isSafeInteger(count) &&
      count > 0 &&
      offset + count <= pool.length,
    "Requested count exceeds available profiles; no silent duplication",
  );
  const selected = pool.slice(offset, offset + count);
  const total =
    count *
    survey.questions.length *
    cfg.conditions.length *
    cfg.models.length *
    cfg.replicates;
  check(total <= cfg.maxCalls, "maxCalls below planned first attempts");
  const implementationHash = hash(
    await Promise.all(
      ["runner.js", "schema.js", "context.js", "calibration.js", "providers.js"].map((name) =>
        readFile(new URL(name, import.meta.url), "utf8"),
      ),
    ),
  );
  const fingerprint = hash({
    implementationHash,
    engine: ENGINE_VERSION,
    survey,
    profiles,
    cfg,
    calibration,
    split,
    count,
    offset,
  });
  await mkdir(out, { recursive: true });
  let lock;
  try {
    lock = await open(join(out, "run.lock"), "wx");
  } catch {
    throw new Error(
      "Output is locked. Inspect running process before removing run.lock.",
    );
  }
  try {
    const mf = join(out, "manifest.json");
    try {
      const old = JSON.parse(await readFile(mf, "utf8"));
      check(
        old.fingerprint === fingerprint,
        "Run fingerprint changed; use a new output directory",
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      await writeFile(
        mf,
        JSON.stringify(
          {
            engine: ENGINE_VERSION,
            fingerprint,
            surveyHash: hash(survey),
            profilesHash: hash(profiles),
            config: cfg,
            calibration,
            split,
            count,
            offset,
            plannedJobs: total,
            createdAt: new Date().toISOString(),
            technicalOnly: cfg.models.every((m) => m.provider === "mock"),
          },
          null,
          2,
        ),
      );
    }
    const rows: RecordRow[] = await readLines(join(out, "responses.jsonl"));
    const events = await readLines(join(out, "events.jsonl"));
    const done = new Set(rows.map((r) => r.job));
    const started = new Set(
      events.filter((e) => e.type === "start").map((e) => e.attemptId),
    );
    const finished = new Set(
      events.filter((e) => e.type === "finish").map((e) => e.attemptId),
    );
    const finishedEvents = new Map(
      events.filter((e) => e.type === "finish").map((e) => [e.attemptId, e]),
    );
    let estimatedSpendUsd = events
      .filter((e) => e.type === "start")
      .reduce((sum: number, e: any) => {
        const end: any = finishedEvents.get(e.attemptId);
        return (
          sum +
          (Number.isFinite(end?.inputTokens) &&
          Number.isFinite(end?.outputTokens)
            ? pricedUsd(end.inputTokens, end.outputTokens, cfg)
            : Number(e.reservedUsd ?? 0))
        );
      }, 0);
    check(
      [...started].every((id) => finished.has(id)),
      "Uncertain interrupted request: inspect journal and use a new run; automatic resend disabled",
    );
    check(
      events
        .filter((e) => e.type === "finish")
        .every((e) => done.has(String(e.attemptId).split(":")[0])),
      "Finished request without committed row: inspect journal before recovery",
    );
    let calls = started.size;
    let failures = events.filter((e) => e.type === "finish" && e.failed).length;
    // Keep donor assignments invariant when the same split is run in shards.
    const shuffled = donors(pool, cfg.seed + 1);
    let stopped: string | null = null;
    outer: for (const p of selected)
      for (const condition of cfg.conditions)
        for (const model of cfg.models)
          for (let replicate = 0; replicate < cfg.replicates; replicate++)
            for (const q of survey.questions) {
              const job = hash([
                fingerprint,
                p.id,
                condition,
                model.id,
                replicate,
                q.id,
              ]);
              if (done.has(job)) continue;
              const donor = shuffled.get(p.id);
              const ctx = context(
                p,
                condition,
                donor,
                train,
                calibration?.questionMarginals[q.id],
              );
              const messages = prompt(
                ctx,
                q,
                cfg.promptVariant,
                survey.language,
              );
              const promptHash = hash(messages);
              let answer = "INVALID",
                status = "invalid",
                attempts = 0,
                inputTokens: number | null = 0,
                outputTokens: number | null = 0,
                resolvedModel = model.id;
              const began = performance.now();
              for (let attempt = 0; attempt < 2; attempt++) {
                if (calls >= cfg.maxCalls) {
                  stopped = "max_calls";
                  break;
                }
                const reservedUsd =
                  model.provider === "mock"
                    ? 0
                    : reserveUsd(messages, model.maxOutputTokens, cfg);
                if (
                  cfg.budget &&
                  estimatedSpendUsd + reservedUsd > cfg.budget.maxUsd
                ) {
                  stopped = "budget_limit";
                  break;
                }
                const attemptId = `${job}:${attempt}`;
                calls++;
                attempts++;
                estimatedSpendUsd += reservedUsd;
                await appendFile(
                  join(out, "events.jsonl"),
                  JSON.stringify({
                    type: "start",
                    attemptId,
                    job,
                    promptHash,
                    reservedUsd,
                    at: new Date().toISOString(),
                  }) + "\n",
                );
                let failed = false,
                  retryable = true,
                  retryDelayMs = 0;
                try {
                  const r = await provider(
                    model,
                    messages,
                    q,
                    `${cfg.seed}:${job}:${attempt}`,
                    cfg.timeoutMs,
                  );
                  resolvedModel = r.resolvedModel;
                  inputTokens =
                    inputTokens === null || r.inputTokens === null
                      ? null
                      : inputTokens + r.inputTokens;
                  outputTokens =
                    outputTokens === null || r.outputTokens === null
                      ? null
                      : outputTokens + r.outputTokens;
                  if (r.inputTokens !== null && r.outputTokens !== null)
                    estimatedSpendUsd +=
                      pricedUsd(r.inputTokens, r.outputTokens, cfg) -
                      reservedUsd;
                  else if (model.provider !== "mock")
                    stopped = "usage_unavailable";
                  if (cfg.budget && estimatedSpendUsd > cfg.budget.maxUsd)
                    stopped = "budget_limit";
                  const parsed = parseAnswer(r.raw, q);
                  failed = parsed === null;
                  if (parsed !== null) {
                    answer = parsed;
                    status = "ok";
                  }
                  await appendFile(
                    join(out, "events.jsonl"),
                    JSON.stringify({
                      type: "finish",
                      attemptId,
                      failed,
                      raw: r.raw,
                      requestId: r.requestId,
                      resolvedModel: r.resolvedModel,
                      inputTokens: r.inputTokens,
                      outputTokens: r.outputTokens,
                    }) + "\n",
                  );
                } catch (e) {
                  failed = true;
                  retryable = e instanceof ProviderError && e.retryable;
                  if (model.provider !== "mock" && retryable) {
                    // A timeout or server error may still have consumed billable tokens.
                    stopped = "request_cost_unknown";
                    retryable = false;
                  }
                  if (
                    e instanceof ProviderError &&
                    e.message.includes("HTTP 429")
                  )
                    retryDelayMs = 2000;
                  status = "provider_error";
                  inputTokens = null;
                  outputTokens = null;
                  await appendFile(
                    join(out, "events.jsonl"),
                    JSON.stringify({
                      type: "finish",
                      attemptId,
                      failed,
                      error:
                        e instanceof ProviderError
                          ? e.message
                          : "Internal adapter error; inspect locally",
                    }) + "\n",
                  );
                  if (!retryable) stopped ??= "provider_error";
                }
                if (failed) failures++;
                if (!failed || !retryable) break;
                if (retryDelayMs > 0)
                  await new Promise((resolve) =>
                    setTimeout(resolve, retryDelayMs),
                  );
                if (calls >= 100 && failures / calls > 0.05) {
                  stopped = "failure_rate";
                  break;
                }
              }
              if (attempts === 0) break outer;
              const row: RecordRow = {
                job,
                profile: p.id,
                question: q.id,
                condition,
                model: model.id,
                replicate,
                answer,
                status,
                weight: p.weight,
                psu: p.psu,
                attempts,
                latencyMs: performance.now() - began,
                inputTokens,
                outputTokens,
                synthetic: true,
                provider: model.provider,
                promptHash,
                promptVariant: cfg.promptVariant,
                resolvedModel,
              };
              await appendFile(
                join(out, "responses.jsonl"),
                JSON.stringify(row) + "\n",
              );
              rows.push(row);
              done.add(job);
              if (stopped || (calls >= 100 && failures / calls > 0.05)) {
                stopped ??= "failure_rate";
                break outer;
              }
            }
    await writeFile(
      join(out, "responses.csv"),
      stringify(rows, { header: true, escape_formulas: true }),
    );
    const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const sumTokens = (key: "inputTokens" | "outputTokens") =>
      rows.some((r) => r[key] === null)
        ? null
        : rows.reduce((a, r) => a + r[key]!, 0);
    const summary = {
      plannedJobs: total,
      completedJobs: rows.length,
      calls,
      failedAttempts: failures,
      invalidRows: rows.filter((r) => r.status !== "ok").length,
      stopped,
      complete: rows.length === total,
      technicalOnly: cfg.models.every((m) => m.provider === "mock"),
      latencyMs: {
        median: latencies[Math.floor(latencies.length * 0.5)] ?? null,
        p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
      },
      inputTokens: sumTokens("inputTokens"),
      outputTokens: sumTokens("outputTokens"),
      estimatedSpendUsd,
      budgetMaxUsd: cfg.budget?.maxUsd ?? null,
      singletonShuffleProfiles: selected.filter(
        (p) => shuffled.get(p.id)?.id === p.id,
      ).length,
    };
    await writeFile(
      join(out, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    return summary;
  } finally {
    await lock.close();
    await unlink(join(out, "run.lock"));
  }
}
