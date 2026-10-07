#!/usr/bin/env node
/**
 * emission-factors MCP server (stdio).
 *
 * A thin, keyless Model Context Protocol server that gives any MCP client
 * (Claude Desktop, Cursor, Cline, ...) live access to US electricity data
 * keyed by ZIP code, from emission-factors.com:
 *
 *   - EPA eGRID grid-carbon emission factors (annual, Scope 2 location-based)
 *   - EIA-861 retail electricity rates
 *   - EIA-930 hourly grid carbon intensity
 *   - EPA CAMD hourly plant-level emissions
 *   - OpenEI URDB utility-specific tariffs
 *
 * No API key and no signup are required. The public API is rate-limited per IP.
 * Most clients can skip this package entirely and just point at the hosted
 * remote server: https://emission-factors.com/mcp  (see the README). This stdio
 * build exists for clients that prefer a local process or self-hosting.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const VERSION = '1.1.0';
const API_BASE = process.env.EMISSION_FACTORS_API_BASE || 'https://emission-factors.com';

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('User-Agent', `emission-factors-mcp/${VERSION}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    const detail = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : text || res.statusText;
    if (res.status === 429) {
      throw new McpError(ErrorCode.InvalidRequest,
        'Rate limit exceeded (2,000 requests/hour per IP). Wait a little and try again.');
    }
    throw new McpError(ErrorCode.InternalError, `API ${res.status}: ${detail}`);
  }
  return body;
}

// Generated from the hosted server (POST /mcp tools/list) so both transports stay identical.
const TOOLS = [
  {
    "name": "lookup_emission_factor",
    "description": "Look up EPA eGRID electricity emission factors for a US ZIP code. Returns CO2e (kg/kWh and lb/MWh), CO2, CH4, N2O, NOx, SO2, non-baseload rate, carbon-free %, generation mix (coal/gas/nuclear/hydro/wind/solar etc.), eGRID subregion code, the data year, and the Green-e residual mix rate (the market-based Scope 2 factor). Use this for Scope 2 location-based and market-based emissions accounting.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code (e.g. \"94105\")",
          "pattern": "^\\d{5}$"
        }
      },
      "required": [
        "zip"
      ]
    }
  },
  {
    "name": "lookup_by_coordinates",
    "description": "Look up emission factors by latitude/longitude. Uses US Census Geocoder to resolve to ZIP first, then returns the same data as lookup_emission_factor. Useful when you have a facility address or lat/lon but no ZIP.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "lat": {
          "type": "number",
          "description": "Latitude (decimal degrees)"
        },
        "lon": {
          "type": "number",
          "description": "Longitude (decimal degrees)"
        }
      },
      "required": [
        "lat",
        "lon"
      ]
    }
  },
  {
    "name": "lookup_batch",
    "description": "Look up emission factors for multiple ZIP codes in a single call. More efficient than calling lookup_emission_factor in a loop. Maximum 100 ZIPs per request.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zips": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^\\d{5}$"
          },
          "description": "Array of 5-digit US ZIP codes",
          "maxItems": 100
        }
      },
      "required": [
        "zips"
      ]
    }
  },
  {
    "name": "calculate_emissions",
    "description": "Calculate Scope 2 CO2e for a facility from its ZIP and kWh, using both GHG Protocol methods: location-based (eGRID subregion rate) and market-based (Green-e residual mix applied to kWh not covered by RECs, PPAs or green tariffs). Returns kg CO2e for each method with the factors used.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code"
        },
        "kwh": {
          "type": "number",
          "description": "Electricity consumption in kWh",
          "minimum": 0
        },
        "renewable_kwh": {
          "type": "number",
          "description": "Optional: kWh covered by contractual instruments (RECs, PPAs, green tariff). Counted at zero in the market-based result. Default 0.",
          "minimum": 0
        }
      },
      "required": [
        "zip",
        "kwh"
      ]
    }
  },
  {
    "name": "hourly_intensity",
    "description": "Get hourly grid carbon intensity (kg CO2e per kWh) for any US ZIP code, derived from EIA-930 hourly fuel-mix data. Data lags approximately 24 hours (not real-time). Returns time series with per-hour fuel mix, total generation, and carbon intensity. Useful for backtesting demand response, computing post-hoc time-weighted Scope 2 emissions, or analyzing grid carbon patterns. For live or forecast intensity, WattTime or Electricity Maps are better options.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code (or use ba parameter)",
          "pattern": "^\\d{5}$"
        },
        "ba": {
          "type": "string",
          "description": "Balancing authority code directly (e.g. CISO, ERCO, PJM, MISO, NYIS). Use this OR zip."
        },
        "hours": {
          "type": "integer",
          "description": "Number of most recent hours to return (default 24, max 168 = 1 week).",
          "minimum": 1,
          "maximum": 168
        }
      }
    }
  },
  {
    "name": "plant_emissions",
    "description": "Get hourly unit-level emissions from EPA Clean Air Markets Division (CAMD) for a specific US power plant or state. Covers ~1,300 fossil units >25 MW reporting to the Acid Rain Program and CSAPR. Per facility returns total CO2 (short tons), gross generation (MWh), heat input (mmBtu), NOx and SO2 (lb), primary fuel type, operating hours, and derived emissions rate (kg CO2/MWh). Data has ~21 day lag to ensure CAMD has published. Use for plant-specific carbon accounting, state-level fossil emissions aggregation, and \"dirtiest plants in [state]\" queries. Paywall-free alternative to S&P Global Market Intelligence ($30k+/yr).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "facility_id": {
          "type": "integer",
          "description": "EPA CAMD facility ID (e.g. 3 for Barry, AL). Look up IDs via the CAMD facilities endpoint."
        },
        "state": {
          "type": "string",
          "description": "2-letter US state code for state-wide aggregate (e.g. TX, CA, PA)."
        },
        "days": {
          "type": "integer",
          "description": "Number of most recent days to include (1-90, default 7).",
          "minimum": 1,
          "maximum": 90
        },
        "begin": {
          "type": "string",
          "description": "Custom begin date YYYY-MM-DD (optional, overrides days).",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "end": {
          "type": "string",
          "description": "Custom end date YYYY-MM-DD (optional, overrides days).",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "format": {
          "type": "string",
          "enum": [
            "summary",
            "hourly"
          ],
          "description": "\"summary\" (default) aggregates by facility; \"hourly\" returns raw records."
        }
      }
    }
  },
  {
    "name": "utility_tariff",
    "description": "Get the actual utility-specific electricity rate (not state average) for a US ZIP code or named utility. Returns the current default tariff with effective rate ($/kWh), fixed monthly charge, tier count, TOU indicator, and effective date. Data source: OpenEI URDB (NREL-hosted). Covers ~85% of US utilities. Upgrade from /api/rate (state average). For example, California state avg is $0.30/kWh but actual tariffs range from $0.21 (CleanPowerSF) to $0.52 (PG&E peak TOU). Does not cover Texas retail electric providers outside the old TDU territory (deregulated market).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code",
          "pattern": "^\\d{5}$"
        },
        "utility": {
          "type": "string",
          "description": "Utility name (e.g. \"Pacific Gas & Electric Co\", \"Consolidated Edison Co-NY Inc\")"
        },
        "eiaid": {
          "type": "integer",
          "description": "EIA utility ID (joins with EIA Form 861)"
        },
        "sector": {
          "type": "string",
          "enum": [
            "Residential",
            "Commercial",
            "Industrial",
            "Lighting"
          ],
          "description": "Default \"Residential\""
        },
        "limit": {
          "type": "integer",
          "description": "Max tariffs to return (1-20, default 5)",
          "minimum": 1,
          "maximum": 20
        }
      }
    }
  },
  {
    "name": "electricity_rate",
    "description": "Get the latest monthly average retail electricity rate ($/kWh and cents/kWh) for any US ZIP code, broken out by sector (residential, commercial, industrial, etc.). Data is state-level from EIA Form 861 - a ballpark, not utility- or ZIP-specific tariffs. Pairs with emission factors to estimate carbon cost in $/tCO2e.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code",
          "pattern": "^\\d{5}$"
        }
      },
      "required": [
        "zip"
      ]
    }
  },
  {
    "name": "compare_sites",
    "description": "Compare and rank 2-25 candidate US sites (ZIP codes) for a facility, data center or EV/flexible load on grid carbon and electricity cost in one call. Per site: eGRID CO2e kg/kWh (location-based), Green-e residual mix (market-based), carbon-free %, state retail $/kWh for the sector, and the cleanest daily window from the hourly grid profile. With annual_kwh, also annual tCO2e and annual cost. Returns ranks by carbon, cost and combined.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zips": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^\\d{5}$"
          },
          "minItems": 2,
          "maxItems": 25,
          "description": "Candidate 5-digit US ZIP codes"
        },
        "annual_kwh": {
          "type": "number",
          "minimum": 0,
          "description": "Optional annual consumption in kWh (e.g. 87,600,000 for a 10 MW constant load) to get annual tCO2e and cost per site"
        },
        "sector": {
          "type": "string",
          "enum": [
            "COM",
            "IND",
            "RES",
            "ALL"
          ],
          "description": "Retail rate sector. Default COM (commercial); use IND for industrial/data-center loads."
        },
        "duration": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "Length of the cleanest daily window in hours (default 4)"
        }
      },
      "required": [
        "zips"
      ]
    }
  },
  {
    "name": "cleanest_hours",
    "description": "Find the cleanest (lowest grid carbon) contiguous window of N hours in the day to run a flexible load (batch jobs, EV charging, pumping, HVAC pre-cooling) at a US ZIP code or balancing authority. Based on the hour-of-day pattern of the last ~7 days of EIA-930 data, in local time. Returns the cleanest and dirtiest windows, % saved vs the daily average, and all hours ranked. A scheduling guide from recent history, not a forecast.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code (or use ba)",
          "pattern": "^\\d{5}$"
        },
        "ba": {
          "type": "string",
          "description": "Balancing authority code (e.g. CISO, ERCO, PJM, MISO, NYIS). Use this OR zip."
        },
        "duration": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "Window length in hours (default 4)"
        }
      }
    }
  },
  {
    "name": "calculate_fuel_emissions",
    "description": "Calculate Scope 1 stationary-combustion emissions (CO2, CH4, N2O and CO2e) for fuels burned on site, using the EPA GHG Emission Factors Hub (2025). Pass one or more items with fuel, quantity and unit, e.g. natural gas in therms/ccf/mcf/scf, propane/diesel/heating oil in gallons, coal in short tons. Biomass CO2 is reported separately (biogenic). Returns per-item and total CO2e. Pair with calculate_emissions for a facility's electricity (Scope 2).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "minItems": 1,
          "maxItems": 50,
          "items": {
            "type": "object",
            "properties": {
              "fuel": {
                "type": "string",
                "description": "Fuel id or alias: natural_gas, propane, diesel, heating_oil, gasoline, lpg, kerosene, jet_fuel, residual_fuel_oil_no_6, bituminous, wood, biodiesel... (63 EPA Hub fuels)"
              },
              "quantity": {
                "type": "number",
                "minimum": 0
              },
              "unit": {
                "type": "string",
                "description": "mmBtu, therm, Dth, scf, ccf, mcf, gallon, liter, barrel, short_ton, lb, tonne. Defaults to the fuel's native unit."
              }
            },
            "required": [
              "fuel",
              "quantity"
            ]
          }
        }
      },
      "required": [
        "items"
      ]
    }
  }
];

const server = new Server(
  { name: 'emission-factors', version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function zip5(v: unknown): string {
  const zip = String(v ?? '').replace(/\D/g, '').slice(0, 5);
  if (!/^\d{5}$/.test(zip)) throw new McpError(ErrorCode.InvalidParams, 'zip must be a 5-digit US ZIP code');
  return zip;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;
    switch (name) {
      case 'lookup_emission_factor': {
        result = await api(`/api/lookup?zip=${zip5(a.zip)}`);
        break;
      }
      case 'lookup_by_coordinates': {
        const lat = Number(a.lat);
        const lon = Number(a.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new McpError(ErrorCode.InvalidParams, 'lat and lon must be numbers');
        }
        result = await api(`/api/lookup/by-coordinates?lat=${lat}&lon=${lon}`);
        break;
      }
      case 'lookup_batch': {
        const zips = Array.isArray(a.zips) ? a.zips.map(String) : [];
        if (zips.length === 0) throw new McpError(ErrorCode.InvalidParams, 'zips must be a non-empty array');
        if (zips.length > 100) throw new McpError(ErrorCode.InvalidParams, 'zips array exceeds 100 items');
        result = await api('/api/lookup/batch', { method: 'POST', body: JSON.stringify({ zips }) });
        break;
      }
      case 'calculate_emissions': {
        const zip = zip5(a.zip);
        const kwh = Number(a.kwh);
        if (!Number.isFinite(kwh) || kwh < 0) throw new McpError(ErrorCode.InvalidParams, 'kwh must be a non-negative number');
        const renewable_kwh = a.renewable_kwh == null ? undefined : Number(a.renewable_kwh);
        result = await api('/api/calculate', { method: 'POST', body: JSON.stringify({ zip, kwh, renewable_kwh }) });
        break;
      }
      case 'hourly_intensity': {
        const qs = new URLSearchParams();
        if (a.zip) qs.set('zip', zip5(a.zip));
        else if (a.ba) qs.set('ba', String(a.ba).toUpperCase());
        else throw new McpError(ErrorCode.InvalidParams, 'provide either zip or ba');
        if (a.hours != null) qs.set('hours', String(Math.min(168, Math.max(1, Number(a.hours)))));
        result = await api(`/api/intensity?${qs}`);
        break;
      }
      case 'plant_emissions': {
        const qs = new URLSearchParams();
        if (a.facility_id != null) qs.set('facility_id', String(Number(a.facility_id)));
        else if (a.state) qs.set('state', String(a.state).toUpperCase());
        else if (!a.begin) throw new McpError(ErrorCode.InvalidParams, 'provide facility_id, state, or begin+end');
        if (a.days != null) qs.set('days', String(Math.min(90, Math.max(1, Number(a.days)))));
        if (a.begin) qs.set('begin', String(a.begin));
        if (a.end) qs.set('end', String(a.end));
        if (a.format) qs.set('format', String(a.format));
        result = await api(`/api/plant-emissions?${qs}`);
        break;
      }
      case 'utility_tariff': {
        const qs = new URLSearchParams();
        if (a.zip) qs.set('zip', zip5(a.zip));
        if (a.utility) qs.set('utility', String(a.utility));
        if (a.eiaid != null) qs.set('eiaid', String(Number(a.eiaid)));
        if (a.sector) qs.set('sector', String(a.sector));
        if (a.limit != null) qs.set('limit', String(Math.min(20, Math.max(1, Number(a.limit)))));
        if (!qs.has('zip') && !qs.has('utility') && !qs.has('eiaid')) {
          throw new McpError(ErrorCode.InvalidParams, 'provide zip, utility, or eiaid');
        }
        result = await api(`/api/utility-rate?${qs}`);
        break;
      }
      case 'electricity_rate': {
        result = await api(`/api/rate?zip=${zip5(a.zip)}`);
        break;
      }
      case 'compare_sites': {
        const zips = Array.isArray(a.zips) ? a.zips.map(String) : [];
        if (zips.length < 2) throw new McpError(ErrorCode.InvalidParams, 'zips must contain at least 2 ZIP codes');
        const body = { zips, annual_kwh: a.annual_kwh, sector: a.sector, duration: a.duration };
        result = await api('/api/compare', { method: 'POST', body: JSON.stringify(body) });
        break;
      }
      case 'cleanest_hours': {
        const qs = new URLSearchParams();
        if (a.zip) qs.set('zip', zip5(a.zip));
        else if (a.ba) qs.set('ba', String(a.ba).toUpperCase());
        else throw new McpError(ErrorCode.InvalidParams, 'provide either zip or ba');
        if (a.duration != null) qs.set('duration', String(a.duration));
        result = await api(`/api/cleanest-hours?${qs}`);
        break;
      }
      case 'calculate_fuel_emissions': {
        const items = Array.isArray(a.items) ? a.items : (a.fuel ? [{ fuel: a.fuel, quantity: a.quantity, unit: a.unit }] : []);
        if (items.length === 0) throw new McpError(ErrorCode.InvalidParams, 'items must be a non-empty array of { fuel, quantity, unit }');
        result = await api('/api/fuel-emissions', { method: 'POST', body: JSON.stringify({ items }) });
        break;
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof McpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, msg);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`emission-factors MCP server ${VERSION} running (keyless, API: ${API_BASE})`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
