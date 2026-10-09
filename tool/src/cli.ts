import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { importSurvey } from "./importer.js";
import { run } from "./runner.js";
import {
  validateConfig,
  validateProfiles,
  validateSurvey,
  check,
} from "./schema.js";
import { evaluate } from "./evaluate.js";
import { trainMarginalCalibration } from "./calibration.js";
const help = `SynthAudit - research CLI\n  import --input form.txt|form.docx --out survey.json\n  run --survey survey.json --profiles profiles.json --config run.json --out runs/name [--count 50] [--offset 0] [--split dev|test] [--calibration-truth truth-train.json]\n  evaluate --survey survey.json --input base.jsonl [--input revised.jsonl] --truth truth.json --out metrics.json\nImported TXT/DOCX files require reviewed:true after manual review. Test is never the default.\n`;
async function main() {
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string", multiple: true },
      out: { type: "string" },
      survey: { type: "string" },
      profiles: { type: "string" },
      config: { type: "string" },
      truth: { type: "string" },
      "calibration-truth": { type: "string" },
      count: { type: "string" },
      offset: { type: "string", default: "0" },
      split: { type: "string", default: "dev" },
      help: { type: "boolean" },
    },
  });
  if (v.help || !positionals.length) {
    console.log(help);
    return;
  }
  const read = async (p: string | undefined) => {
    check(p, "Missing file argument");
    return JSON.parse(await readFile(p, "utf8"));
  };
  check(v.out, "--out required");
  if (positionals[0] === "import") {
    check(v.input?.length === 1, "import requires one --input");
    await writeFile(
      v.out,
      JSON.stringify(await importSurvey(v.input[0]), null, 2),
    );
    console.log(
      "Imported. Review wording, options and eligibility; set reviewed:true before running.",
    );
  } else if (positionals[0] === "run") {
    check(v.split === "dev" || v.split === "test", "split must be dev or test");
    const survey = validateSurvey(await read(v.survey));
    const profiles = validateProfiles(await read(v.profiles), survey);
    const cfg = validateConfig(await read(v.config));
    const calibration = v["calibration-truth"] === undefined
      ? undefined
      : trainMarginalCalibration(
        await read(v["calibration-truth"]),
        profiles,
        survey,
      );
    console.log(
      JSON.stringify(
        await run(
          survey,
          profiles,
          cfg,
          v.out,
          v.split,
          v.count === undefined ? undefined : Number(v.count),
          undefined,
          Number(v.offset),
          calibration,
        ),
        null,
        2,
      ),
    );
  } else if (positionals[0] === "evaluate") {
    check(v.input?.length, "--input required");
    const rows = (
      await Promise.all(v.input.map((path) => readFile(path, "utf8")))
    ).flatMap((content) =>
      content
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x)),
    );
    await writeFile(
      v.out,
      JSON.stringify(
        evaluate(
          rows,
          await read(v.truth),
          validateSurvey(await read(v.survey)),
        ),
        null,
        2,
      ),
    );
  } else throw new Error(help);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
