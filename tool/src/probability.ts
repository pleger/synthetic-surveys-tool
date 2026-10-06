import { hash, type Question } from "./schema.js";

/** Draw one reproducible answer from a profile-level categorical distribution. */
export function sampleAnswer(
  question: Question,
  probabilities: Record<string, number>,
  drawKey: string,
): string {
  const codes = question.options.map((option) => option.code);
  if (
    Object.keys(probabilities).length !== codes.length ||
    Object.keys(probabilities).some((code) => !codes.includes(code))
  ) throw new Error("Probability vector must contain exactly the allowed codes");
  const values = codes.map((code) => probabilities[code]);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
    throw new Error("Probabilities must be finite and between 0 and 1");
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-6)
    throw new Error("Probabilities must sum to one");
  const u = Number.parseInt(hash(drawKey).slice(0, 13), 16) / 0x10000000000000;
  let cumulative = 0;
  for (let i = 0; i < codes.length; i++) {
    cumulative += values[i];
    if (u < cumulative) return codes[i];
  }
  return codes[codes.length - 1];
}
