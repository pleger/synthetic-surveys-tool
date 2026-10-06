import type { Profile, Survey, RunConfig } from "./schema.js";
export const survey: Survey = {
  version: "fixture-v1",
  language: "en",
  reviewed: true,
  questions: [
    {
      id: "q_transport",
      topic: "mobility",
      text: "Which form of transport do you prefer for a short trip?",
      options: [
        { code: "walk", label: "Walk" },
        { code: "bike", label: "Bicycle" },
        { code: "bus", label: "Bus" },
      ],
    },
    {
      id: "q_schedule",
      topic: "mobility",
      text: "When do you prefer to travel?",
      options: [
        { code: "am", label: "Morning" },
        { code: "pm", label: "Afternoon" },
      ],
    },
    {
      id: "q_library",
      topic: "services",
      text: "Which library hours do you prefer?",
      options: [
        { code: "weekday", label: "Weekdays" },
        { code: "weekend", label: "Weekends" },
      ],
    },
    {
      id: "q_park",
      topic: "services",
      text: "Which park facility do you prefer?",
      options: [
        { code: "benches", label: "Benches" },
        { code: "paths", label: "Paths" },
        { code: "games", label: "Play areas" },
      ],
    },
  ],
};
export function profiles(): Profile[] {
  return Array.from({ length: 150 }, (_, i) => ({
    id: `fictional-${i}`,
    split: i < 100 ? "train" : "dev",
    psu: `fixture-cluster-${Math.floor(i / 5)}`,
    weight: 1 + (i % 3) * 0.25,
    cell: `${i % 2}:${Math.floor(i / 2) % 3}`,
    demographics: { age: 20 + (i % 60), area: i % 2 ? "urban" : "rural" },
    values: { planning: i % 3, community: i % 2 },
  }));
}
export const config: RunConfig = {
  seed: 20260923,
  replicates: 5,
  conditions: ["D", "D+C", "D+C-shuffled", "D+C-group"],
  models: [
    { id: "fixture-a", provider: "mock", maxOutputTokens: 100 },
    { id: "fixture-b", provider: "mock", maxOutputTokens: 100 },
  ],
  maxCalls: 8800,
  timeoutMs: 1000,
  promptVariant: "base",
  allowRemoteData: false,
};
