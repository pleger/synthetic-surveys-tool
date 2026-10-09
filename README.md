# SynthAudit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

SynthAudit is a TypeScript command-line tool for generating and auditing synthetic answers to single-choice surveys. It turns a reviewed questionnaire and eligible profiles into traceable synthetic response records, then evaluates those records against a separate human reference.

It is designed for research audits. The central question is not only whether generated records look plausible, but whether their aggregate distributions, individual agreement, nonresponse behavior, and sensitivity to contextual information are documented and inspectable. Every run writes response records and an execution trail so that a result can be checked later.

This repository contains **software and fictional examples only**. It does not contain a paper, real respondent profiles, source-survey microdata, API keys, API journals, or empirical study results.

## What SynthAudit does

1. **Imports a questionnaire.** Converts a reviewed TXT or DOCX single-choice questionnaire into structured JSON.
2. **Generates response records.** Runs a deterministic local mock provider or an API-backed provider for selected eligible profiles.
3. **Records the execution.** Writes canonical JSONL responses, a CSV export, a manifest, an event journal, and a summary for each run.
4. **Evaluates the output.** Compares synthetic records with a separate human reference and reports weighted total variation, individual agreement, and nonresponse diagnostics.

SynthAudit does not establish that a synthetic sample is valid by itself and does not replace human survey data.

## Requirements and quick start

- Node.js 22 or newer
- npm

```sh
npm ci
npm test
npm run pilot
```

The pilot makes no network requests and uses fictional profiles with a deterministic mock provider. It writes example inputs, response records, and a technical report to `runs/technical-pilot/`. Its metrics verify the software workflow; they are not evidence that synthetic responses match people.

## Worked example: fictional local survey

The following end-to-end example uses only the fixtures included in this repository. It does not make network requests or require an API key.

First, create the fictional inputs and run the mock-provider pilot:

```sh
npm run pilot
```

The command creates `runs/technical-pilot/`, including a reviewed questionnaire, fictional profiles, a mock-provider configuration, synthetic responses, an execution journal, and a technical report.

You can then generate a new response grid for the first 50 development profiles:

```sh
npm run survey -- run \
  --survey runs/technical-pilot/survey.json \
  --profiles runs/technical-pilot/profiles.json \
  --config runs/technical-pilot/config.json \
  --out runs/example --split dev --count 50
```

Finally, compare those generated responses with the fictional human reference:

```sh
npm run survey -- evaluate \
  --survey runs/technical-pilot/survey.json \
  --input runs/example/responses.jsonl \
  --truth runs/technical-pilot/fixture-truth.json \
  --out runs/example/metrics.json
```

Inspect `runs/example/metrics.json` for metrics, `responses.jsonl` for the canonical long-format records, `responses.csv` for a tabular export, and the manifest and event journal for execution details.

## Import a questionnaire

TXT and DOCX questionnaires use the same strict line grammar. The included examples are [`tool/examples/survey.txt`](tool/examples/survey.txt) and [`tool/examples/survey.docx`](tool/examples/survey.docx).

```sh
npm run survey -- import --input tool/examples/survey.txt --out survey.json
```

Review the generated question text, answer codes, order, and eligibility, then change `reviewed` to `true` in `survey.json`. The importer does not infer skip logic or administrative response codes. For nonresponse policies, add explicit option roles in reviewed JSON.

Each human-reference row has the form `{ "profile": "...", "question": "...", "answer": "...", "weight": 1.0 }`. A run produces `responses.jsonl`, `responses.csv`, a manifest, an event journal, and a summary. The evaluator reports weighted distributional total variation, individual agreement, and nonresponse diagnostics.

## Live model calls

[`tool/examples/run-live.template.json`](tool/examples/run-live.template.json) shows the Responses API configuration. Set `allowRemoteData` to `true` only after confirming that profile data may be sent to the provider. Set a local USD budget and current per-token prices, and provide the API key through `OPENAI_API_KEY` in the environment. The CLI does not load `.env` automatically.

```sh
export OPENAI_API_KEY="your-key"
npm run survey -- run --survey survey.json --profiles profiles.json \
  --config run-live.json --out runs/live --split dev --count 50
```

Do not commit credentials, real respondent profiles, raw API journals, or generated responses. The local budget is **per run**, not an account-wide hard spending limit. The tool requires distinct eligible profiles; `--count 500` needs at least 500 profiles in the selected partition. The test partition is never the default.

## Supported design

- Context conditions: demographics (`D`), own values (`D+C`), within-cell reassigned values (`D+C-shuffled`), training-group summaries (`D+C-group`), and supervised training-answer margins (`D+C+marginal`).
- Prompt policies: base, paraphrase, response-aware, response-calibrated, and interviewer-like.
- Providers: local deterministic mock, OpenAI-compatible Responses, and compatible chat-completions endpoints.
- Single-choice items only. Repeated generations do not increase the number of human respondents.

Training-answer margins are a **supervised known-item** condition. They must not be described as zero-shot prediction. See [the usage guide](tool/docs/USAGE.md) for input schemas, safeguards, and recovery behavior.

## Scope and responsible use

SynthAudit supports research audits; it does not validate a synthetic sample by itself or replace human survey data. Public access to a dataset does not automatically authorize transmitting individual records to an external API. Before a live run, review the data provider's terms, institutional or project governance requirements, de-identification, target leakage, and the model provider's data-transfer conditions.

## Creator

SynthAudit was created by [Paul Leger](https://pleger.cl).

## License

This project is distributed under the [MIT License](LICENSE).
