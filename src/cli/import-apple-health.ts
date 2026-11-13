import fs from "node:fs";
import { AppleExportError, chunkNormalized, parseAppleExport } from "../parse/apple.js";
import type { Normalized } from "../types.js";

interface Options {
  file: string;
  chunkUrl: string;
  token: string;
  timeZone: string;
  sourcePriority: string;
  datesPerChunk: number;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    file: "",
    chunkUrl: "",
    token: process.env.HEALTH_INGEST_TOKEN || "",
    timeZone: process.env.HEALTH_TIMEZONE || "UTC",
    sourcePriority: process.env.HEALTH_SOURCE_PRIORITY || "",
    datesPerChunk: 31,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chunk-url") options.chunkUrl = argv[++index] || "";
    else if (arg === "--token") options.token = argv[++index] || "";
    else if (arg === "--time-zone") options.timeZone = argv[++index] || "";
    else if (arg === "--source-priority") options.sourcePriority = argv[++index] || "";
    else if (arg === "--dates-per-chunk") options.datesPerChunk = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error("Unexpected argument");
  }
  return options;
}

async function* fileBytes(file: string): AsyncGenerator<Uint8Array> {
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) {
    yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  }
}

function sizedChunks(normalized: Normalized, datesPerChunk: number, maxBytes: number): Normalized[] {
  const chunks = chunkNormalized(normalized, datesPerChunk);
  const out: Normalized[] = [];
  for (const chunk of chunks) {
    if (JSON.stringify(chunk).length > maxBytes && datesPerChunk > 1) out.push(...sizedChunks(chunk, Math.ceil(datesPerChunk / 2), maxBytes));
    else out.push(chunk);
  }
  return out;
}

async function postChunks(normalized: Normalized, options: Options) {
  const chunks = sizedChunks(normalized, options.datesPerChunk, 4_500_000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let samples = 0;
  let workouts = 0;
  let events = 0;
  const dates: string[] = [];
  const batches = chunks.length ? chunks : [{ samples: [], workouts: [], events: [], series: [] }];
  for (const chunk of batches) {
    const response = await fetch(options.chunkUrl, { method: "POST", headers, body: JSON.stringify(chunk) });
    const body = (await response.json().catch(() => ({}))) as { error?: string; samples?: number; workouts?: number; events?: number; dates?: string[] };
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    samples += body.samples || 0;
    workouts += body.workouts || 0;
    events += body.events || 0;
    for (const date of body.dates || []) dates.push(date);
  }
  return { ok: true, dates: [...new Set(dates)].sort(), samples, workouts, events };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.file || !options.chunkUrl) {
    console.error("Usage: npm run import:apple -- <export.xml|export.zip> --chunk-url URL [--time-zone TZ] [--source-priority Names] [--dates-per-chunk N]");
    console.error("Default source priority is Apple Watch, then iPhone. Names match device class, ignoring case and apostrophes.");
    console.error("If the zip fails, unzip it with: ditto -x -k export.zip export-dir");
    console.error("Set HEALTH_INGEST_TOKEN in the environment. A token on the command line is visible to other users on the machine.");
    process.exit(options.help ? 0 : 1);
  }
  const parsed = await parseAppleExport(fileBytes(options.file), {
    timeZone: options.timeZone,
    sourcePriority: options.sourcePriority,
  });
  const result = await postChunks(parsed, options);
  console.log(JSON.stringify({ ...result, export_day: parsed.exportDay, bytes: parsed.bytes }));
}

main().catch((error: unknown) => {
  const message = error instanceof AppleExportError ? error.message : error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
