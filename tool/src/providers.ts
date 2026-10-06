import { hash, type Model, type Question } from "./schema.js";
export interface Reply {
  raw: string;
  inputTokens: number | null;
  outputTokens: number | null;
  resolvedModel: string;
  requestId?: string;
}
export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}
export async function respond(
  model: Model,
  messages: { system: string; user: string },
  question: Question,
  key: string,
  timeoutMs: number,
): Promise<Reply> {
  if (model.provider === "mock") {
    const index =
      parseInt(hash(key + messages.user).slice(0, 8), 16) %
      question.options.length;
    return {
      raw: JSON.stringify({ answer: question.options[index].code }),
      inputTokens: 0,
      outputTokens: 0,
      resolvedModel: model.id,
    };
  }
  const apiKey = model.keyEnv ? process.env[model.keyEnv] : undefined;
  if (model.keyEnv && !apiKey)
    throw new ProviderError(
      `Missing environment variable ${model.keyEnv}`,
      false,
    );
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string", enum: question.options.map((o) => o.code) },
    },
    required: ["answer"],
    additionalProperties: false,
  };
  const body =
    model.provider === "responses"
      ? {
          model: model.id,
          store: false,
          instructions: messages.system,
          input: messages.user,
          max_output_tokens: model.maxOutputTokens,
          ...(model.reasoningEffort === undefined
            ? {}
            : { reasoning: { effort: model.reasoningEffort } }),
          text: {
            format: {
              type: "json_schema",
              name: "survey_answer",
              strict: true,
              schema,
            },
          },
          ...(model.temperature === undefined
            ? {}
            : { temperature: model.temperature }),
        }
      : {
          model: model.id,
          messages: [
            { role: "system", content: messages.system },
            { role: "user", content: messages.user },
          ],
          max_tokens: model.maxOutputTokens,
          ...(model.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: model.reasoningEffort }),
          response_format: {
            type: "json_schema",
            json_schema: { name: "survey_answer", strict: true, schema },
          },
          ...(model.temperature === undefined
            ? {}
            : { temperature: model.temperature }),
        };
  let response: Response;
  try {
    response = await fetch(model.endpoint!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new ProviderError(
      "Network failure or timeout; provider may have processed the request",
      true,
    );
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((x: any) => x?.error)
      .catch(() => undefined);
    const code = typeof detail?.code === "string" ? ` ${detail.code}` : "";
    const message = typeof detail?.message === "string"
      ? `: ${detail.message.slice(0, 180)}`
      : "";
    throw new ProviderError(
      `Provider HTTP ${response.status}${code}${message}`,
      response.status === 429 || response.status >= 500,
    );
  }
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError("Non-JSON provider response", true);
  }
  const raw =
    model.provider === "responses"
      ? (data.output ?? [])
          .flatMap((x: any) => x.content ?? [])
          .filter((x: any) => x.type === "output_text")
          .map((x: any) => x.text)
          .join("")
      : (data.choices?.[0]?.message?.content ?? "");
  return {
    raw: typeof raw === "string" ? raw : "",
    inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? null,
    outputTokens:
      data.usage?.output_tokens ?? data.usage?.completion_tokens ?? null,
    resolvedModel: data.model ?? model.id,
    requestId: response.headers.get("x-request-id") ?? undefined,
  };
}
export function parseAnswer(raw: string, q: Question): string | null {
  try {
    const v = JSON.parse(raw);
    if (
      Object.keys(v).length !== 1 ||
      typeof v.answer !== "string" ||
      !q.options.some((o) => o.code === v.answer)
    )
      return null;
    return v.answer;
  } catch {
    return null;
  }
}
