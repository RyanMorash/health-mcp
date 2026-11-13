function timingSafeEq(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

/** True when Authorization is `Bearer <HEALTH_INGEST_TOKEN>`. An empty secret never matches. */
export function authed(req: Request, token: string | undefined): boolean {
  const expected = typeof token === "string" ? token.trim() : "";
  if (!expected) return false;
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return false;
  return timingSafeEq(match[1], expected);
}

export function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized" },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": 'Bearer realm="health-mcp"',
      },
    },
  );
}
