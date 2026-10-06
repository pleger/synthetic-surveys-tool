import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { survey, profiles, config } from "../src/fixtures.js";
import { validateProfiles, validateSurvey } from "../src/schema.js";
import { run } from "../src/runner.js";
import { parseText } from "../src/importer.js";
import { parseAnswer, ProviderError } from "../src/providers.js";
import { donors, groupValues, prompt } from "../src/context.js";
import { sampleAnswer } from "../src/probability.js";
import { trainMarginalCalibration } from "../src/calibration.js";
import { tv, evaluate } from "../src/evaluate.js";
const small = {
  ...config,
  conditions: ["D" as const],
  models: [config.models[0]],
  replicates: 1,
  maxCalls: 8,
};
const temp = () => mkdtemp(join(tmpdir(), "survey-test-"));
test("rejects target leakage and split cluster overlap", () => {
  let p = profiles();
  p[0].values.q_transport = "walk";
  assert.throws(() => validateProfiles(p, survey), /Target/);
  p = profiles();
  p[100].psu = p[0].psu;
  assert.throws(() => validateProfiles(p, survey), /PSU leakage/);
});
test("strict import preserves option codes and requires review", () => {
  const s = parseText("Q q | demo | Pick one\nA -8 | Don't know\nA x | Yes");
  assert.equal(s.questions[0].options[0].code, "-8");
  assert.throws(() => validateSurvey(s), /reviewed/);
  assert.throws(() => parseText("An ambiguous paragraph"), /Cannot parse/);
  assert.throws(
    () =>
      validateSurvey({
        ...survey,
        questions: [{ ...survey.questions[0], skip: "q" }],
      }),
    /Unknown/,
  );
});
test("answer validation retains refusal and malformed outcomes", () => {
  assert.equal(parseAnswer('{"answer":"walk"}', survey.questions[0]), "walk");
  assert.equal(parseAnswer('{"answer":"invented"}', survey.questions[0]), null);
  assert.equal(parseAnswer("I refuse", survey.questions[0]), null);
});
test("shuffling stays within cell and group summaries use training", () => {
  const p = profiles(),
    ds = donors(p, 100);
  for (const r of p) {
    assert.equal(ds.get(r.id)!.cell, r.cell);
    assert.equal(ds.get(r.id)!.split, r.split);
    assert.notEqual(ds.get(r.id)!.id, r.id);
  }
  const g = groupValues(
    p[100],
    p.filter((x) => x.split === "train"),
  );
  assert.equal(g.n, 100);
  for (const counts of Object.values(g.distributions))
    assert.ok(
      Math.abs(Object.values(counts).reduce((a, b) => a + b) - 1) < 1e-12,
    );
});
test("resume is idempotent and detects changed input", async () => {
  const out = await temp();
  const a = await run(survey, profiles(), small, out, "dev", 1);
  const b = await run(survey, profiles(), small, out, "dev", 1);
  assert.equal(a.calls, 4);
  assert.equal(b.calls, 4);
  assert.equal(b.completedJobs, 4);
  await assert.rejects(
    () => run(survey, profiles(), { ...small, seed: 2 }, out, "dev", 1),
    /fingerprint/,
  );
});
test("retry cap and invalid records remain auditable", async () => {
  const out = await temp();
  const bad = async () => ({
    raw: "not JSON",
    inputTokens: 2,
    outputTokens: 1,
    resolvedModel: "fixture-a",
  });
  const r = await run(survey, profiles(), small, out, "dev", 1, bad);
  assert.equal(r.calls, 8);
  assert.equal(r.invalidRows, 4);
  const rows = (await readFile(join(out, "responses.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse as any);
  assert.ok(rows.every((r: any) => r.answer === "INVALID"));
});
test("fatal provider errors stop instead of exhausting a budget", async () => {
  const out = await temp();
  const bad = async () => {
    throw new ProviderError("HTTP 401", false);
  };
  const r = await run(survey, profiles(), small, out, "dev", 1, bad);
  assert.equal(r.calls, 1);
  assert.equal(r.stopped, "provider_error");
  assert.equal(r.inputTokens, null);
});
test("pending interrupted request cannot be silently replayed", async () => {
  const out = await temp();
  await run(survey, profiles(), small, out, "dev", 1);
  await appendFile(
    join(out, "events.jsonl"),
    JSON.stringify({ type: "start", attemptId: "uncertain" }) + "\n",
  );
  await assert.rejects(
    () => run(survey, profiles(), small, out, "dev", 1),
    /Uncertain interrupted/,
  );
});
test("TV oracle and weighted replicates do not inflate people", async () => {
  assert.equal(tv({ a: 1 }, { b: 1 }), 1);
  assert.equal(tv({ a: 0.25, b: 0.75 }, { a: 0.5, b: 0.5 }), 0.25);
  const out = await temp();
  await run(survey, profiles(), small, out, "dev", 1);
  const rows = (await readFile(join(out, "responses.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  const truth = rows.map((r) => ({
    profile: r.profile,
    question: r.question,
    answer: r.answer,
    weight: r.weight,
  }));
  const result = evaluate(rows, truth, survey);
  assert.ok(
    result.every(
      (r) => r.tv === 0 && r.individualAccuracy === 1 && r.people === 1,
    ),
  );
});
test("incomplete evaluation grid is rejected", async () => {
  const out = await temp();
  await run(survey, profiles(), small, out, "dev", 1);
  const rows = (await readFile(join(out, "responses.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  const truth = rows.map((r) => ({
    profile: r.profile,
    question: r.question,
    answer: r.answer,
    weight: r.weight,
  }));
  assert.throws(
    () => evaluate(rows.slice(1), truth, survey),
    /Missing questionnaire/,
  );
});
test("DOCX and TXT imports agree", async () => {
  const { importSurvey } = await import("../src/importer.js");
  assert.deepEqual(
    await importSurvey("tool/examples/survey.docx"),
    await importSurvey("tool/examples/survey.txt"),
  );
});
test("Responses adapter sends strict schema and store:false", async () => {
  const { createServer } = await import("node:http");
  const { respond } = await import("../src/providers.js");
  let body: any;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: "local-contract-fixture",
        output: [
          { content: [{ type: "output_text", text: '{"answer":"walk"}' }] },
        ],
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const addr = server.address() as any;
    const reply = await respond(
      {
        id: "local-contract-fixture",
        provider: "responses",
        endpoint: `http://127.0.0.1:${addr.port}`,
        maxOutputTokens: 100,
        reasoningEffort: "none",
      },
      { system: "fixture", user: "fixture" },
      survey.questions[0],
      "key",
      1000,
    );
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.reasoning, { effort: "none" });
    assert.equal(reply.outputTokens, 5);
    assert.equal(parseAnswer(reply.raw, survey.questions[0]), "walk");
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
test("response-aware prompt separates substantive options from recorded nonresponse", () => {
  const q = {
    id: "q",
    topic: "health",
    text: "What do you think?",
    options: [
      { code: "1", label: "Approve" },
      { code: "DK", label: "Don't know", role: "dont_know" as const },
      { code: "NA", label: "No answer", role: "no_answer" as const },
    ],
  };
  const rendered = prompt({ age: 40 }, q, "response_aware", "en");
  const body = JSON.parse(rendered.user);
  assert.deepEqual(
    body.question.responseOptions.map((o: any) => o.code),
    ["1"],
  );
  assert.deepEqual(
    body.question.recordedNonresponseCodes.map((o: any) => o.code),
    ["DK", "NA"],
  );
  assert.match(
    rendered.system,
    /Lack of a biographical detail alone is not a reason to abstain/,
  );
});
test("interviewer-like prompt does not present recording codes as choices", () => {
  const q = { id: "q", topic: "health", text: "Choose one", options: [
    { code: "1", label: "Yes" },
    { code: "2", label: "No" },
    { code: "DK", label: "Don't know", role: "dont_know" as const },
  ] };
  const rendered = prompt({ age: 40 }, q, "interviewer_like", "en");
  const body = JSON.parse(rendered.user);
  assert.deepEqual(body.question.presentedOptions.map((o: any) => o.code), ["1", "2"]);
  assert.deepEqual(body.interviewerRecordCodes.map((o: any) => o.code), ["DK"]);
  assert.equal(body.question.recordedNonresponseCodes, undefined);
});
test("probability sampler validates codes and is reproducible", () => {
  const q = { id: "q", topic: "x", text: "x", options: [
    { code: "1", label: "Yes" }, { code: "2", label: "No" },
  ] };
  assert.equal(sampleAnswer(q, { "1": 1, "2": 0 }, "draw-1"), "1");
  assert.equal(sampleAnswer(q, { "1": 0.4, "2": 0.6 }, "draw-2"),
    sampleAnswer(q, { "1": 0.4, "2": 0.6 }, "draw-2"));
  assert.throws(() => sampleAnswer(q, { "1": 0.4, "2": 0.7 }, "draw-3"));
  assert.throws(() => sampleAnswer(q, { "1": 1, DK: 0 }, "draw-4"));
});
test("training marginals reject development labels and are visible to calibrated prompts", () => {
  const all = profiles();
  const train = all.filter((profile) => profile.split === "train");
  const truth = train.flatMap((profile, index) =>
    survey.questions.map((question) => ({
      profile: profile.id,
      question: question.id,
      answer: question.options[index % question.options.length].code,
      weight: profile.weight,
    })),
  );
  const calibration = trainMarginalCalibration(truth, all, survey);
  assert.equal(calibration.sourcePeople, train.length);
  assert.ok(
    Math.abs(
      Object.values(calibration.questionMarginals.q_transport).reduce(
        (a, b) => a + b,
        0,
      ) - 1,
    ) < 1e-12,
  );
  assert.throws(
    () =>
      trainMarginalCalibration(
        [
          ...truth,
          {
            profile: all[100].id,
            question: "q_transport",
            answer: "walk",
            weight: all[100].weight,
          },
        ],
        all,
        survey,
      ),
    /only use train/,
  );
  const calibrationQuestion = {
    ...survey.questions[0],
    options: [
      ...survey.questions[0].options,
      { code: "DK", label: "Don't know", role: "dont_know" as const },
      { code: "NA", label: "No answer", role: "no_answer" as const },
    ],
  };
  const rendered = prompt(
    { responseCalibration: { targetDistribution: { walk: 0.5 } } },
    calibrationQuestion,
    "response_calibrated",
    "en",
  );
  assert.match(rendered.system, /separate training sample/);
});
test("calibrated condition requires training-only calibration", async () => {
  const out = await temp();
  await assert.rejects(
    () =>
      run(
        survey,
        profiles(),
        {
          ...small,
          conditions: ["D+C+marginal"],
          promptVariant: "response_calibrated",
        },
        out,
        "dev",
        1,
      ),
    /Training marginal calibration/,
  );
});
test("calibrated condition runs with a complete training-only margin", async () => {
  const all = profiles();
  const calibratedSurvey = {
    ...survey,
    questions: survey.questions.map((question) => ({
      ...question,
      options: [
        ...question.options,
        { code: "DK", label: "Don't know", role: "dont_know" as const },
        { code: "NA", label: "No answer", role: "no_answer" as const },
      ],
    })),
  };
  const truth = all
    .filter((profile) => profile.split === "train")
    .flatMap((profile, index) =>
      calibratedSurvey.questions.map((question) => ({
        profile: profile.id,
        question: question.id,
        answer: question.options[index % (question.options.length - 2)].code,
        weight: profile.weight,
      })),
    );
  const out = await temp();
  const result = await run(
    calibratedSurvey,
    all,
    {
      ...small,
      conditions: ["D+C+marginal"],
      promptVariant: "response_calibrated",
    },
    out,
    "dev",
    1,
    undefined,
    0,
    trainMarginalCalibration(truth, all, calibratedSurvey),
  );
  assert.equal(result.completedJobs, calibratedSurvey.questions.length);
});
test("budget guard counts actual usage and stops before another paid request", async () => {
  const out = await temp();
  const paid = {
    ...small,
    models: [
      {
        id: "local-contract-fixture",
        provider: "responses" as const,
        endpoint: "http://127.0.0.1:12345",
        maxOutputTokens: 64,
      },
    ],
    budget: {
      maxUsd: 0.0003,
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.5,
    },
  };
  const fake = async (_model: any, _messages: any, q: any) => ({
    raw: JSON.stringify({ answer: q.options[0].code }),
    inputTokens: 1800,
    outputTokens: 64,
    resolvedModel: "local-contract-fixture",
  });
  const result = await run(survey, profiles(), paid, out, "dev", 1, fake);
  assert.equal(result.calls, 1);
  assert.equal(result.stopped, "budget_limit");
  assert.ok(result.estimatedSpendUsd <= paid.budget.maxUsd);
});
test("uncertain remote failure is not automatically resent", async () => {
  const out = await temp();
  const paid = {
    ...small,
    models: [
      {
        id: "local-contract-fixture",
        provider: "responses" as const,
        endpoint: "http://127.0.0.1:12345",
        maxOutputTokens: 64,
      },
    ],
    budget: { maxUsd: 1, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5 },
  };
  const result = await run(
    survey,
    profiles(),
    paid,
    out,
    "dev",
    1,
    async () => {
      throw new ProviderError("Network failure or timeout", true);
    },
  );
  assert.equal(result.calls, 1);
  assert.equal(result.stopped, "request_cost_unknown");
  assert.ok(result.estimatedSpendUsd > 0);
});
test("evaluation reports nonresponse and undefined conditional TV explicitly", () => {
  const q = {
    id: "q",
    topic: "health",
    text: "Opinion?",
    options: [
      { code: "1", label: "Yes" },
      { code: "2", label: "No" },
      { code: "DK", label: "Don't know", role: "dont_know" as const },
      { code: "NA", label: "No answer", role: "no_answer" as const },
    ],
  };
  const s = { version: "v1", language: "en", reviewed: true, questions: [q] };
  const truth = [
    { profile: "a", question: "q", answer: "1", weight: 1 },
    { profile: "b", question: "q", answer: "DK", weight: 1 },
  ];
  const rows = ["base", "response_aware"].flatMap((variant) =>
    ["a", "b"].map((id) => ({
      job: `${variant}:${id}`,
      profile: id,
      question: "q",
      condition: "D+C",
      model: "luna",
      promptVariant: variant,
      replicate: 0,
      weight: 1,
      answer: variant === "base" ? "DK" : "1",
    })),
  ) as any;
  const metrics = evaluate(rows, truth, s);
  assert.equal(
    metrics.find((m) => m.promptVariant === "base")!.syntheticDontKnowRate,
    1,
  );
  assert.equal(
    metrics.find((m) => m.promptVariant === "base")!.conditionalSubstantiveTv,
    null,
  );
  assert.equal(
    metrics.find((m) => m.promptVariant === "response_aware")!.nonresponseGap,
    -0.5,
  );
});
