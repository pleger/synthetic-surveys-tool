import { check, type Profile, type Survey } from "./schema.js";

export interface TrainMarginalCalibration {
  source: "weighted_train_marginal";
  sourcePeople: number;
  questionMarginals: Record<string, Record<string, number>>;
}

/** Build question-specific margins from rows belonging exclusively to train. */
export function trainMarginalCalibration(
  truthInput: unknown,
  profiles: Profile[],
  survey: Survey,
): TrainMarginalCalibration {
  check(Array.isArray(truthInput), "Calibration truth must be an array");
  const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
  const questions = new Map(
    survey.questions.map((question) => [question.id, question]),
  );
  const seen = new Set<string>();
  const margins: Record<string, Record<string, number>> = {};
  for (const question of survey.questions)
    margins[question.id] = Object.fromEntries(
      question.options.map((option) => [option.code, 0]),
    );
  for (const row of truthInput) {
    check(row && typeof row === "object" && !Array.isArray(row), "Invalid calibration row");
    const value = row as Record<string, unknown>;
    check(
      Object.keys(value).every((key) =>
        ["profile", "question", "answer", "weight"].includes(key),
      ),
      "Unknown calibration field",
    );
    check(
      typeof value.profile === "string" &&
        typeof value.question === "string" &&
        typeof value.answer === "string" &&
        typeof value.weight === "number" &&
        Number.isFinite(value.weight),
      "Invalid calibration row",
    );
    const profile = byProfile.get(value.profile);
    const question = questions.get(value.question);
    check(profile !== undefined, "Calibration profile not found");
    check(profile.split === "train", "Calibration may only use train profiles");
    check(question !== undefined, "Calibration question not found");
    check(
      question.options.some((option) => option.code === value.answer),
      "Calibration answer not allowed for question",
    );
    check(
      Math.abs(profile.weight - value.weight) < 1e-12,
      "Calibration weight mismatch",
    );
    const key = `${value.profile}:${value.question}`;
    check(!seen.has(key), "Duplicate calibration profile-question");
    seen.add(key);
    margins[value.question][value.answer] += value.weight;
  }
  const train = profiles.filter((profile) => profile.split === "train");
  for (const question of survey.questions) {
    check(
      train.every((profile) => seen.has(`${profile.id}:${question.id}`)),
      "Calibration lacks a train profile-question",
    );
    const total = Object.values(margins[question.id]).reduce((a, b) => a + b, 0);
    check(total > 0, "Calibration question has no weight");
    for (const code in margins[question.id]) margins[question.id][code] /= total;
  }
  return {
    source: "weighted_train_marginal",
    sourcePeople: train.length,
    questionMarginals: margins,
  };
}
