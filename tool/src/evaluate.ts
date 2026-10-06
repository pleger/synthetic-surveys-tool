import { check, type Survey } from "./schema.js";
import type { RecordRow } from "./runner.js";
export interface Truth {
  profile: string;
  question: string;
  answer: string;
  weight: number;
}
export function tv(p: Record<string, number>, s: Record<string, number>) {
  return (
    [...new Set([...Object.keys(p), ...Object.keys(s)])].reduce(
      (a, k) => a + Math.abs((p[k] ?? 0) - (s[k] ?? 0)),
      0,
    ) / 2
  );
}
export function evaluate(rows: RecordRow[], truth: Truth[], survey: Survey) {
  check(rows.length > 0, "No responses");
  check(
    new Set(rows.map((r) => r.job)).size === rows.length,
    "Duplicate job records",
  );
  const grid = new Map<string, string>();
  for (const r of rows) {
    const key = JSON.stringify([
      r.model,
      r.promptVariant ?? "legacy",
      r.condition,
      r.question,
    ]);
    grid.set(key, "");
  }
  let reference: string | undefined;
  for (const key of grid.keys()) {
    const [m, variant, c, q] = JSON.parse(key);
    const signature = JSON.stringify(
      rows
        .filter(
          (r) =>
            r.model === m &&
            (r.promptVariant ?? "legacy") === variant &&
            r.condition === c &&
            r.question === q,
        )
        .map((r) => `${r.profile}:${r.replicate}`)
        .sort(),
    );
    check(
      reference === undefined || signature === reference,
      "Incomplete or unmatched response grid",
    );
    reference = signature;
  }
  for (const mc of new Set(
    rows.map((r) =>
      JSON.stringify([r.model, r.promptVariant ?? "legacy", r.condition]),
    ),
  )) {
    const [m, variant, c] = JSON.parse(mc);
    check(
      survey.questions.every((q) =>
        grid.has(JSON.stringify([m, variant, c, q.id])),
      ),
      "Missing questionnaire item",
    );
  }
  const actual = new Map(truth.map((t) => [`${t.profile}:${t.question}`, t]));
  check(actual.size === truth.length, "Duplicate truth rows");
  const groups = new Map<string, RecordRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.model,
      row.promptVariant ?? "legacy",
      row.condition,
      row.question,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const results = [];
  for (const [key, g] of groups) {
    const [model, promptVariant, condition, question] = JSON.parse(key);
    check(
      survey.questions.some((q) => q.id === question),
      "Unknown target",
    );
    const perPerson = new Map<string, RecordRow[]>();
    for (const r of g) {
      perPerson.set(r.profile, [...(perPerson.get(r.profile) ?? []), r]);
    }
    const p: Record<string, number> = {},
      s: Record<string, number> = {};
    let sum = 0,
      correct = 0;
    for (const [id, rs] of perPerson) {
      const t = actual.get(`${id}:${question}`);
      check(t, "Missing held-out truth");
      check(
        new Set(rs.map((r) => r.replicate)).size === rs.length,
        "Duplicate replicate",
      );
      check(
        rs.every((r) => Math.abs(r.weight - t.weight) < 1e-8),
        "Truth/prediction weights differ",
      );
      sum += t.weight;
      p[t.answer] = (p[t.answer] ?? 0) + t.weight;
      for (const r of rs) {
        s[r.answer] = (s[r.answer] ?? 0) + t.weight / rs.length;
        if (r.answer === t.answer) correct += t.weight / rs.length;
      }
    }
    for (const v of [p, s]) for (const k in v) v[k] /= sum;
    const options = survey.questions.find((q) => q.id === question)!.options;
    const codes = (role: "dont_know" | "refused" | "no_answer") =>
      options.filter((o) => o.role === role).map((o) => o.code);
    const nonresponseRolesPresent =
      codes("dont_know").length > 0 && codes("no_answer").length > 0;
    const share = (
      dist: Record<string, number>,
      role: "dont_know" | "refused" | "no_answer",
    ) => codes(role).reduce((total, code) => total + (dist[code] ?? 0), 0);
    const humanDontKnowRate = nonresponseRolesPresent
      ? share(p, "dont_know")
      : null;
    const syntheticDontKnowRate = nonresponseRolesPresent
      ? share(s, "dont_know")
      : null;
    const humanNoAnswerRate = nonresponseRolesPresent
      ? share(p, "no_answer")
      : null;
    const syntheticNoAnswerRate = nonresponseRolesPresent
      ? share(s, "no_answer")
      : null;
    const humanRefusedRate = codes("refused").length
      ? share(p, "refused")
      : null;
    const syntheticRefusedRate = codes("refused").length
      ? share(s, "refused")
      : null;
    const substantive = options
      .filter((o) => o.role === undefined || o.role === "substantive")
      .map((o) => o.code);
    const humanSubstantiveMass = nonresponseRolesPresent
      ? substantive.reduce((a, code) => a + (p[code] ?? 0), 0)
      : null;
    const syntheticSubstantiveMass = nonresponseRolesPresent
      ? substantive.reduce((a, code) => a + (s[code] ?? 0), 0)
      : null;
    const conditionalSubstantiveTv =
      humanSubstantiveMass !== null &&
      syntheticSubstantiveMass !== null &&
      humanSubstantiveMass > 0 &&
      syntheticSubstantiveMass > 0
        ? tv(
            Object.fromEntries(
              substantive.map((code) => [
                code,
                (p[code] ?? 0) / humanSubstantiveMass,
              ]),
            ),
            Object.fromEntries(
              substantive.map((code) => [
                code,
                (s[code] ?? 0) / syntheticSubstantiveMass,
              ]),
            ),
          )
        : null;
    results.push({
      model,
      promptVariant,
      condition,
      question,
      people: perPerson.size,
      replicatesPerPerson: [
        ...new Set([...perPerson.values()].map((v) => v.length)),
      ],
      tv: tv(p, s),
      individualAccuracy: correct / sum,
      invalidRate: s.INVALID ?? 0,
      humanDontKnowRate,
      syntheticDontKnowRate,
      humanNoAnswerRate,
      syntheticNoAnswerRate,
      humanRefusedRate,
      syntheticRefusedRate,
      nonresponseGap: nonresponseRolesPresent
        ? syntheticDontKnowRate! +
          syntheticNoAnswerRate! +
          (syntheticRefusedRate ?? 0) -
          humanDontKnowRate! -
          humanNoAnswerRate! -
          (humanRefusedRate ?? 0)
        : null,
      humanSubstantiveMass,
      syntheticSubstantiveMass,
      conditionalSubstantiveTv,
    });
  }
  return results;
}
