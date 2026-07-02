# emission-factors MCP server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-8A2BE2)](https://modelcontextprotocol.io)
[![No key required](https://img.shields.io/badge/auth-none%20(keyless)-brightgreen)](https://emission-factors.com)

Give Claude, Cursor, Cline, or any [MCP](https://modelcontextprotocol.io) client live access to **US electricity data by ZIP code** - grid-carbon emission factors, retail rates, hourly grid carbon intensity, power-plant emissions, and utility tariffs.

Backed by [emission-factors.com](https://emission-factors.com), which wraps EPA eGRID, EIA-861, EIA-930, EPA CAMD, and OpenEI URDB into one ZIP-keyed API.

**Free. No API key, no signup.** The API is rate-limited per IP (2,000 requests/hour).

---

## What you can ask

Once connected, your agent can answer things like:

- *"My HQ in ZIP 94105 uses 1.2M kWh/year. What's our Scope 2 carbon footprint and annual electricity cost?"*
- *"Compare Denver, Austin, and Columbus for a new data center on grid carbon intensity and electricity price."*
- *"What hour of the day is cleanest to run a 500 kW batch job in California this week?"*
- *"Enrich this list of 40 store ZIP codes with each site's emission factor and carbon-free percentage."*
- *"Which are the dirtiest power plants in Texas by CO2 over the last week?"*
- *"What's the actual PG&E residential tariff for 94105, not the state average?"*

## Why use it

- **Scope 2 carbon accounting** - GHG Protocol location-based emission factors for all 33,616 US ZIP codes (CDP, CSRD, California SB 253 inputs).
- **Site selection** - compare candidate locations on both carbon intensity *and* electricity cost in one conversation.
- **Time-weighted / demand-response analysis** - hourly grid carbon from EIA-930 for load-shifting and post-hoc Scope 2.
- **Plant-level emissions** - EPA CAMD hourly data for ~1,300 fossil units, a paywall-free alternative to commercial datasets.
- **Agents and automation** - a clean tool surface so an LLM can fetch authoritative government data instead of hallucinating factors.

---

## Quick start

There are two ways to run this. Most people want **Option A**.

### Option A - Remote server (recommended, zero install)

Point your client at the hosted MCP endpoint. Nothing to install, always up to date.

**Claude Desktop** - edit `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows), then restart Claude:

```json
{
  "mcpServers": {
    "emission-factors": {
      "url": "https://emission-factors.com/mcp"
    }
  }
}
```

**Cursor** - Settings -> MCP -> Add new MCP server, using the same URL.

**Cline / Continue / Zed / other clients** - add a remote (Streamable HTTP) MCP server with URL `https://emission-factors.com/mcp`. No key needed.

### Option B - Local stdio server (this package)

Runs the server as a local process that proxies the same public API. Useful for clients that only support stdio transport, or if you want to self-host.

Run straight from GitHub (builds on install, requires Node 18+):

```json
{
  "mcpServers": {
    "emission-factors": {
      "command": "npx",
      "args": ["-y", "github:rozetyp/emission-factors-mcp"]
    }
  }
}
```

Or clone and run from source:

```bash
git clone https://github.com/rozetyp/emission-factors-mcp.git
cd emission-factors-mcp
npm install        # builds dist/ via the prepare script
```

```json
{
  "mcpServers": {
    "emission-factors": {
      "command": "node",
      "args": ["/absolute/path/to/emission-factors-mcp/dist/index.js"]
    }
  }
}
```

Optional environment variable: `EMISSION_FACTORS_API_BASE` (defaults to `https://emission-factors.com`) if you run your own instance of the API.

---

## Tools

Eight tools, all keyed by US ZIP code (or a direct code where noted). The remote server and this stdio build expose the same set.

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `lookup_emission_factor` | EPA eGRID CO2e + full generation mix for a ZIP | `zip` |
| `lookup_by_coordinates` | Same, resolved from lat/lon via Census geocoder | `lat`, `lon` |
| `lookup_batch` | Emission factors for up to 100 ZIPs at once | `zips[]` |
| `calculate_emissions` | Scope 2 kg/tonnes CO2e for a ZIP + annual kWh | `zip`, `kwh` |
| `hourly_intensity` | Hourly grid carbon intensity (EIA-930, ~24h lag) | `zip` or `ba`, `hours` |
| `plant_emissions` | Hourly unit-level plant emissions (EPA CAMD) | `facility_id` or `state`, `days` |
| `utility_tariff` | Utility-specific tariff, not state average (OpenEI URDB) | `zip`, `utility`, or `eiaid` |
| `electricity_rate` | State-average retail rate by sector (EIA-861) | `zip` |

All tools return JSON. See [full API docs](https://emission-factors.com/api-docs) for exact response shapes.

---

## Data sources

| Data | Source | Notes |
|------|--------|-------|
| Grid emission factors | EPA eGRID2023 Rev2 (+2024 preliminary) | Annual, location-based, 27 subregions |
| Retail electricity rates | EIA Form 861 | State-level monthly average by sector |
| Hourly grid carbon intensity | EIA-930 | Derived from hourly fuel mix, ~24h lag |
| Plant-level emissions | EPA CAMD | ~1,300 fossil units >25 MW, ~21 day lag |
| Utility-specific tariffs | OpenEI URDB (NREL) | ~85% of US utilities |
| ZIP / lat-lon resolution | US Census (ZCTA + Geocoder) | ZIP -> eGRID subregion mapping |

## Rate limits and auth

- **No API key, no signup.** Every request is anonymous.
- **2,000 requests/hour per IP.** Generous for interactive use; if you hit it you get an HTTP 429 with a `retryAfter` hint.
- The external-data endpoints are cached server-side (24h rates, 1h hourly intensity, 7d tariffs, 24h plant emissions), so repeated calls are fast and don't burn upstream quotas.

## Also available

- **REST API** - the same data over plain HTTP: `curl "https://emission-factors.com/api/lookup?zip=94105"`. See the [API docs](https://emission-factors.com/api-docs) and [OpenAPI spec](https://emission-factors.com/openapi.json).
- **Hosted MCP setup guide** - [emission-factors.com/mcp-setup](https://emission-factors.com/mcp-setup)
- **Machine-readable summary for agents** - [emission-factors.com/llms.txt](https://emission-factors.com/llms.txt)

---

## Development

```bash
npm install        # install deps and build (prepare -> tsc)
npm run build      # compile TypeScript to dist/
npm run dev        # watch mode
npm start          # run the built server over stdio
```

Quick smoke test with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

The server is a thin proxy: each tool maps to one `/api/*` endpoint on emission-factors.com, validates inputs, and returns the JSON response. There is no local state and no key handling.

## License

MIT - see [LICENSE](LICENSE). Data belongs to its respective US government sources (EPA, EIA, Census) and NREL/OpenEI; this project and the API are an unofficial wrapper, not affiliated with those agencies.
