import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { check, validateSurvey, type Survey } from "./schema.js";
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function docxText(path: string): Promise<string> {
  const archive = await JSZip.loadAsync(await readFile(path));
  const document = archive.file("word/document.xml");
  check(document, "DOCX is missing word/document.xml");
  const xml = await document.async("string");
  const dom = new DOMParser({
    errorHandler: (level, message) => {
      if (level === "fatalError") throw new Error(message);
    },
  }).parseFromString(xml, "application/xml");
  const paragraphs = dom.getElementsByTagNameNS(WORD_NS, "p");
  const lines: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const textNodes = paragraphs.item(i)!.getElementsByTagNameNS(WORD_NS, "t");
    let line = "";
    for (let j = 0; j < textNodes.length; j++)
      line += textNodes.item(j)!.textContent ?? "";
    lines.push(line);
  }
  return lines.join("\n");
}
// Deliberately strict author-reviewed grammar; never guesses options or skip logic.
export function parseText(text: string): Survey {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const survey: Survey = {
    version: "1",
    language: "en",
    reviewed: false,
    questions: [],
  };
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("LANGUAGE:")) {
      survey.language = line.slice(9).trim();
      continue;
    }
    if (line.startsWith("VERSION:")) {
      survey.version = line.slice(8).trim();
      continue;
    }
    const header = /^Q\s+([^|]+)\|([^|]+)\|(.+)$/.exec(line);
    if (header) {
      survey.questions.push({
        id: header[1].trim(),
        topic: header[2].trim(),
        text: header[3].trim(),
        options: [],
      });
      continue;
    }
    const option = /^A\s+([^|]+)\|(.+)$/.exec(line);
    check(
      option && survey.questions.length > 0,
      `Cannot parse line: ${line}. Use Q id | topic | text and A code | label; review skip logic manually.`,
    );
    survey.questions
      .at(-1)!
      .options.push({ code: option[1].trim(), label: option[2].trim() });
  }
  validateSurvey({ ...survey, reviewed: true });
  return survey;
}
export async function importSurvey(path: string): Promise<Survey> {
  if (path.endsWith(".json"))
    return validateSurvey(JSON.parse(await readFile(path, "utf8")));
  const text = path.endsWith(".docx")
    ? await docxText(path)
    : await readFile(path, "utf8");
  return parseText(text);
}
