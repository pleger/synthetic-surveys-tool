import { createHash } from "node:crypto";
export const CONDITIONS = [
  "D",
  "D+C",
  "D+C-shuffled",
  "D+C-group",
  "D+C+marginal",
] as const;
export type Condition = (typeof CONDITIONS)[number];
export type PromptVariant =
  | "base"
  | "paraphrase"
  | "response_aware"
  | "response_calibrated"
  | "interviewer_like";
export type Fields = Record<string, string | number>;
export interface Profile {
  id: string;
  split: "train" | "dev" | "test";
  weight: number;
  psu: string;
  demographics: Fields;
  values: Fields;
  cell: string;
}
export interface Question {
  id: string;
  topic: string;
  text: string;
  options: {
    code: string;
    label: string;
    role?: "substantive" | "dont_know" | "refused" | "no_answer";
  }[];
}
export interface Survey {
  version: string;
  language: string;
  reviewed: boolean;
  questions: Question[];
}
export interface Model {
  id: string;
  provider: "mock" | "responses" | "chat";
  endpoint?: string;
  keyEnv?: string;
  temperature?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  maxOutputTokens: number;
}
export interface RunConfig {
  seed: number;
  replicates: number;
  conditions: Condition[];
  models: Model[];
  maxCalls: number;
  timeoutMs: number;
  promptVariant: PromptVariant;
  allowRemoteData: boolean;
  budget?: {
    maxUsd: number;
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  };
}
export const hash = (x: unknown): string =>
  createHash("sha256")
    .update(typeof x === "string" ? x : JSON.stringify(x))
    .digest("hex");
export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function object(x: unknown): asserts x is Record<string, unknown> {
  check(x && typeof x === "object" && !Array.isArray(x), "Expected object");
}
function exact(x: Record<string, unknown>, keys: string[]) {
  check(
    Object.keys(x).every((k) => keys.includes(k)),
    `Unknown fields: ${Object.keys(x)
      .filter((k) => !keys.includes(k))
      .join(", ")}`,
  );
}
function fields(x: unknown): asserts x is Fields {
  object(x);
  for (const [k, v] of Object.entries(x)) {
    check(
      k.length > 0 &&
        (typeof v === "string" ||
          (typeof v === "number" && Number.isFinite(v))),
      "Profile fields must be finite numbers or strings",
    );
  }
}
export function validateSurvey(x: unknown): Survey {
  object(x);
  exact(x, ["version", "language", "reviewed", "questions"]);
  check(
    typeof x.version === "string" && typeof x.language === "string",
    "Missing survey version/language",
  );
  check(x.reviewed === true, "Survey must be reviewed before running");
  check(
    Array.isArray(x.questions) && x.questions.length > 0,
    "Empty questionnaire",
  );
  for (const q of x.questions) {
    object(q);
    exact(q, ["id", "topic", "text", "options"]);
    check(
      typeof q.id === "string" &&
        q.id.length &&
        typeof q.topic === "string" &&
        typeof q.text === "string" &&
        q.text.trim(),
      "Invalid question",
    );
    check(
      Array.isArray(q.options) && q.options.length >= 2,
      "At least two response options required",
    );
    for (const o of q.options) {
      object(o);
      exact(o, ["code", "label", "role"]);
      check(
        typeof o.code === "string" &&
          o.code.length &&
          o.code !== "INVALID" &&
          typeof o.label === "string" &&
          o.label.trim(),
        "Invalid response option",
      );
      check(
        o.role === undefined ||
          ["substantive", "dont_know", "refused", "no_answer"].includes(String(o.role)),
        "Invalid response role",
      );
    }
    check(
      new Set(q.options.map((o) => o.code)).size === q.options.length,
      "Duplicate option codes",
    );
  }
  check(
    new Set(x.questions.map((q) => q.id)).size === x.questions.length,
    "Duplicate question IDs",
  );
  return x as unknown as Survey;
}
export function validateProfiles(x: unknown, survey: Survey): Profile[] {
  check(Array.isArray(x) && x.length > 0, "No profiles");
  const ids = new Set<string>();
  const psus = new Map<string, string>();
  const targets = new Set(survey.questions.map((q) => q.id));
  for (const p of x) {
    object(p);
    exact(p, [
      "id",
      "split",
      "weight",
      "psu",
      "demographics",
      "values",
      "cell",
    ]);
    check(
      typeof p.id === "string" && p.id.length && !ids.has(p.id),
      "Missing/duplicate profile ID",
    );
    ids.add(p.id);
    check(["train", "dev", "test"].includes(String(p.split)), "Invalid split");
    check(
      typeof p.weight === "number" && Number.isFinite(p.weight) && p.weight > 0,
      "Invalid weight",
    );
    check(
      typeof p.psu === "string" && p.psu.length && typeof p.cell === "string",
      "Missing cluster/cell",
    );
    check(
      !psus.has(p.psu) || psus.get(p.psu) === p.split,
      "PSU leakage across partitions",
    );
    psus.set(p.psu, String(p.split));
    fields(p.demographics);
    fields(p.values);
    check(
      Object.keys(p.demographics).every((k) => !targets.has(k)) &&
        Object.keys(p.values).every((k) => !targets.has(k)),
      "Target field in context",
    );
    const values = p.values;
    check(
      Object.keys(p.demographics).every((k) => !(k in values)),
      "Overlapping context blocks",
    );
  }
  return x as Profile[];
}
export function validateConfig(x: unknown): RunConfig {
  object(x);
  exact(x, [
    "seed",
    "replicates",
    "conditions",
    "models",
    "maxCalls",
    "timeoutMs",
    "promptVariant",
    "allowRemoteData",
    "budget",
  ]);
  for (const k of ["seed", "replicates", "maxCalls", "timeoutMs"])
    check(Number.isSafeInteger(x[k]) && Number(x[k]) > 0, `Invalid ${k}`);
  check(
    ["base", "paraphrase", "response_aware", "response_calibrated", "interviewer_like"].includes(
      String(x.promptVariant),
    ),
    "Unknown prompt variant",
  );
  check(typeof x.allowRemoteData === "boolean", "allowRemoteData required");
  if (x.budget !== undefined) {
    object(x.budget);
    exact(x.budget, ["maxUsd", "inputUsdPerMillion", "outputUsdPerMillion"]);
    for (const key of ["maxUsd", "inputUsdPerMillion", "outputUsdPerMillion"])
      check(
        typeof x.budget[key] === "number" &&
          Number.isFinite(x.budget[key]) &&
          Number(x.budget[key]) > 0,
        `Invalid budget ${key}`,
      );
  }
  check(
    Array.isArray(x.conditions) &&
      x.conditions.length > 0 &&
      x.conditions.every((c) => CONDITIONS.includes(c)) &&
      new Set(x.conditions).size === x.conditions.length,
    "Invalid conditions",
  );
  check(Array.isArray(x.models) && x.models.length > 0, "No models");
  for (const m of x.models) {
    object(m);
    exact(m, [
      "id",
      "provider",
      "endpoint",
      "keyEnv",
      "temperature",
      "reasoningEffort",
      "maxOutputTokens",
    ]);
    check(
      typeof m.id === "string" &&
        m.id.length &&
        ["mock", "responses", "chat"].includes(String(m.provider)),
      "Invalid model",
    );
    check(
      Number.isSafeInteger(m.maxOutputTokens) && Number(m.maxOutputTokens) > 0,
      "Invalid output token limit",
    );
    check(
      m.reasoningEffort === undefined ||
        ["none", "low", "medium", "high", "xhigh", "max"].includes(
          String(m.reasoningEffort),
        ),
      "Invalid reasoning effort",
    );
    check(
      m.temperature === undefined ||
        (typeof m.temperature === "number" &&
          m.temperature >= 0 &&
          m.temperature <= 2),
      "Invalid temperature",
    );
    if (m.provider !== "mock") {
      check(x.budget !== undefined, "Budget required for live provider");
      check(typeof m.endpoint === "string", "Endpoint required");
      const u = new URL(m.endpoint);
      check(
        !u.username && !u.password && !u.search && !u.hash,
        "Endpoint must not contain credentials/query",
      );
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      check(
        u.protocol === "https:" || (u.protocol === "http:" && local),
        "HTTPS required except localhost",
      );
      check(
        local || x.allowRemoteData === true,
        "Remote transmission not enabled in config",
      );
      check(
        m.keyEnv === undefined || typeof m.keyEnv === "string",
        "keyEnv must be a variable name",
      );
    }
  }
  check(
    new Set(x.models.map((m) => m.id)).size === x.models.length,
    "Duplicate model IDs",
  );
  return x as unknown as RunConfig;
}
