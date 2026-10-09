# SynthAudit CLI usage and safeguards

Run commands from the repository root after `npm ci`. `npm run survey -- --help` prints all CLI subcommands.

## Questionnaire

The importer accepts reviewed JSON, or TXT/DOCX in a strict line format:

```text
LANGUAGE: en
VERSION: example-v1
Q q_transport | mobility | Which form of transport do you prefer for a short trip?
A walk | Walk
A bike | Bicycle
A bus | Bus
```

The generated survey has `reviewed:false`; inspect and set it to `true` before running. For nonresponse policies, add explicit option roles (`dont_know`, `refused`, `no_answer`) in reviewed JSON. Unconditional, single-choice items are supported. Skip logic, eligibility, and questionnaire mode must be resolved before import.

## Profiles and partitions

`profiles.json` is an array of objects like:

```json
{
  "id": "fictional-001",
  "split": "dev",
  "weight": 1.0,
  "psu": "cluster-001",
  "cell": "age-band-a",
  "demographics": {"age": 35},
  "values": {"community": 1}
}
```

IDs must be unique, weights positive, and clusters cannot cross train/dev/test partitions. A target question ID cannot appear as a context-field key. The validator cannot detect semantic leakage hidden in arbitrary values; review the data source separately. `--count` and `--offset` select distinct profiles from a stable seed ordering. Test requires `--split test`.

## Configuration

The live template contains a model ID, provider, endpoint, reasoning effort, output-token limit, conditions, replicates, prompt variant, maximum calls, timeout, remote-data switch, and local USD budget. `maxCalls` includes retries. A live run reserves a conservative cost before each request and reconciles it with provider-reported tokens. Unknown usage, uncertain remote failures, or a pending interrupted request stop further paid calls pending inspection. The run lock blocks simultaneous writers, and a changed configuration cannot resume into the same output directory. Separate independent runs require separate directories.

The `responses` adapter requests strict JSON-schema output with `store:false`. The `chat` adapter requires a compatible endpoint. Credentials belong in an environment variable named by `keyEnv`, never in the JSON configuration. HTTPS is required except for localhost.

The local USD budget does not control other processes or the provider account. Check current model prices and account billing before live execution. `survey:shards` rejects paid runs with per-shard budgets because those would multiply the effective cap.

## Evaluation

Use `evaluate` with one or more `--input` JSONL files and a separate truth file. Every model/prompt/context/item cell must have a matched profile/replicate grid. The evaluator verifies weights, codes, and grid completeness. It reports weighted total variation, conditional substantive TV when defined, individual agreement, and distinct DK/refusal/no-answer rates. These are descriptive metrics; the CLI does not claim design-valid uncertainty or representative sampling.

The pilot uses only fictional records. Before using real data, review source terms, consent or governance requirements, de-identification, target leakage, sampling design, and provider transfer conditions.
