# Security

How the token works and what to watch for. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

`HEALTH_INGEST_TOKEN` is the credential for every route. `/ingest`, `/import/apple-health/chunk`, `/summary`, and `/mcp` accept any client that sends that bearer token. There is no user account and no second check. An empty token rejects every request. Anyone who has the token can read and write the health data this Worker stores.

There is no URL token. Health Auto Export sends `Authorization`. Do not put the token in a query string or a path.

Use at least 32 random bytes:

```bash
openssl rand -hex 32
```

Store it with `npx wrangler secret put HEALTH_INGEST_TOKEN`. Do not commit it. `.dev.vars` is gitignored and is only for `wrangler dev`.

Prefer the `HEALTH_INGEST_TOKEN` environment variable over `--token` on the Apple importer. A value on the command line is visible to other users on the machine, in the process list, and often in shell history.

To rotate the token, generate a new value and run `npx wrangler secret put HEALTH_INGEST_TOKEN` again, then update every automation and MCP client. The previous token stops working on the next request. There is no overlap.

`workers_dev` defaults to `true`, which publishes a public `workers.dev` hostname. Anyone who learns that hostname and the token can call the API. Set `workers_dev` to `false` when the Worker should not be reachable there. Workers Logs and traces are on. They can contain request URLs and error names. They do not include the token by design, but a client that puts the token in the URL would leak it into those logs. Do not do that.

Requests without an `Origin` header are allowed. Native MCP clients call `/mcp` that way. A request that sends `Origin` is rejected with `403` unless that origin is listed in `MCP_ALLOWED_ORIGINS`, a comma-separated list. An empty list rejects every browser-origin request. Changing it requires a deploy.

The Worker does not store raw request bodies. Series objects in R2 are the arrays Health Auto Export or the Apple importer already extracted (routes, voltage, beat-to-beat readings), addressed by a hash of the JSON.
