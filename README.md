# Synthetic Surveys Tool

A TypeScript command-line tool for generating and auditing synthetic answers to single-choice surveys. It imports a reviewed TXT or DOCX questionnaire, runs mock or API-backed respondent simulations, and evaluates synthetic answers against a separate human reference. The repository contains **software and fictional examples only**.

## Requirements and quick start

- Node.js 22 or newer
- npm

```sh
npm ci
npm test
npm run pilot
```

The pilot makes no network requests and uses fictional profiles with a deterministic mock provider. It writes example inputs, response records, and a technical report to `runs/technical-pilot/`. Its metrics verify the software workflow; they are not evidence that synthetic responses match people.

## Import and run

TXT and DOCX questionnaires use the same line grammar. The included examples are [`tool/examples/survey.txt`](tool/examples/survey.txt) and [`tool/examples/survey.docx`](tool/examples/survey.docx).

```sh
npm run survey -- import --input tool/examples/survey.txt --out survey.json
```

Review the generated question text, answer codes, order, and eligibility, then change `reviewed` to `true` in `survey.json`. The importer does not infer skip logic or administrative response codes. To run the local mock provider on the pilot fixtures:

```sh
npm run survey -- run \
  --survey runs/technical-pilot/survey.json \
  --profiles runs/technical-pilot/profiles.json \
  --config runs/technical-pilot/config.json \
  --out runs/example --split dev --count 50
```

To evaluate a completed grid, supply reference responses separately:

```sh
npm run survey -- evaluate \
  --survey runs/technical-pilot/survey.json \
  --input runs/example/responses.jsonl \
  --truth runs/technical-pilot/fixture-truth.json \
  --out runs/example/metrics.json
```

Each human-reference row is `{ "profile": "...", "question": "...", "answer": "...", "weight": 1.0 }`. `responses.jsonl` is the canonical long-format output; the runner also writes `responses.csv`, an execution manifest, event journal, and summary. Evaluation reports weighted distributional total variation, individual agreement, and nonresponse diagnostics.

## Live model calls

[`tool/examples/run-live.template.json`](tool/examples/run-live.template.json) shows the Responses API configuration. Set `allowRemoteData` to `true` only after confirming that your profile data may be sent to the provider. Set a local USD budget and current per-token prices, and provide the API key through `OPENAI_API_KEY` in your environment. The CLI does not load `.env` automatically.

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

Training-answer margins are a **supervised known-item** condition. They must not be described as zero-shot prediction. See [usage details](tool/docs/USAGE.md) for schemas, safeguards, and recovery behavior.

## Scope

This tool supports research audits; it does not validate a synthetic sample by itself or replace human survey data. Public access to a dataset does not automatically authorize transmitting individual records to an external API.
