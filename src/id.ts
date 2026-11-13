export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recordId(parts: unknown[]): Promise<string> {
  return (await sha256(JSON.stringify(parts))).slice(0, 32);
}

export async function seriesKey(body: unknown): Promise<string> {
  return `series/${(await sha256(JSON.stringify(body))).slice(0, 32)}`;
}

export function isSeriesKey(value: unknown): value is string {
  return typeof value === "string" && /^series\/[a-f0-9]{32}$/.test(value);
}
