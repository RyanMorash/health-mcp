/**
 * D1 free daily row limits reset at 00:00 UTC.
 * https://developers.cloudflare.com/d1/observability/debug-d1/
 */

const WRITE_LIMIT = "exceeded D1's free tier daily row write limit";
const READ_LIMIT = "exceeded D1's free tier daily row read limit";

export function d1DailyLimitKind(error: unknown): "d1_rows_written" | "d1_rows_read" | null {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "string") parts.push(current);
    else if (typeof current === "object" && current && "message" in current) parts.push(String((current as { message?: unknown }).message));
    current = typeof current === "object" && current && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  const message = parts.join("\n");
  if (message.includes(WRITE_LIMIT)) return "d1_rows_written";
  if (message.includes(READ_LIMIT)) return "d1_rows_read";
  return null;
}

export function secondsUntilNextUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export function dailyLimitResponse(limit: string, now = new Date()): Response {
  console.log(JSON.stringify({ limit_hit: limit, plan: "free tier; upgrade when a real limit is hit" }));
  return Response.json(
    { error: "daily_limit", limit_hit: limit },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(secondsUntilNextUtcMidnight(now)),
      },
    },
  );
}
