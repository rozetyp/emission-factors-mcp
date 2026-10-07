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

const VERSION = '1.7.1';
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
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const detail = [b.error, b.message, b.notes].filter(Boolean).map(String).join(': ') || text || res.statusText;
    if (res.status === 429) {
      throw new McpError(ErrorCode.InvalidRequest,
        'Rate limit exceeded (2,000 requests/hour per IP). Wait a little and try again.');
    }
    // 4xx = the arguments were wrong; 5xx = an upstream data source is down (retry).
    throw new McpError(res.status < 500 ? ErrorCode.InvalidParams : ErrorCode.InternalError, `API ${res.status}: ${detail}`);
  }
  return body;
}

// Generated from the hosted server (POST /mcp tools/list) so both transports stay identical.
const TOOLS = [
  {
    "name": "lookup_emission_factor",
    "description": "Look up EPA eGRID electricity emission factors for a US ZIP code. Returns CO2e (kg/kWh and lb/MWh), CO2, CH4, N2O, NOx, SO2, non-baseload rate, carbon-free %, generation mix (coal/gas/nuclear/hydro/wind/solar etc.), eGRID subregion code, the data year, and the Green-e residual mix rate (the market-based Scope 2 factor). For Scope 2 emissions from a kWh total, use calculate_emissions, which does the arithmetic for both methods.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code (e.g. \"94105\"); ZIP+4 accepted",
          "pattern": "^\\d{5}(-?\\d{4})?$"
        },
        "year": {
          "type": "string",
          "enum": [
            "2023",
            "2024"
          ],
          "description": "eGRID edition: 2023 (default, official EPA) or 2024 (EPA's public eGRID code run on 2024 data by Cornerstone; EPA has not published eGRID2024)"
        }
      },
      "required": [
        "zip"
      ]
    },
    "annotations": {
      "readOnlyHint": true
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
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "lookup_batch",
    "description": "Look up emission factors for up to 100 ZIP codes in one call (split longer lists). Returns one compact row per ZIP - subregion, CO2e kg/kWh (location-based), residual mix (market-based), carbon-free %, utility - unless full is true, which returns every field (about 2 KB per ZIP).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zips": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^\\d{5}(-?\\d{4})?$"
          },
          "description": "Array of US ZIP codes (5 digits or ZIP+4)",
          "maxItems": 100
        },
        "full": {
          "type": "boolean",
          "description": "Return complete candidate records (all pollutants, generation mix) instead of compact rows. Default false."
        }
      },
      "required": [
        "zips"
      ]
    },
    "annotations": {
      "readOnlyHint": true
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
          "description": "5-digit US ZIP code (ZIP+4 accepted)",
          "pattern": "^\\d{5}(-?\\d{4})?$"
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
        },
        "year": {
          "type": "string",
          "enum": [
            "2023",
            "2024"
          ],
          "description": "eGRID edition (default 2023). Market-based needs 2023."
        }
      },
      "required": [
        "zip",
        "kwh"
      ]
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "hourly_intensity",
    "description": "Get hourly grid carbon intensity (kg CO2e per kWh) for any US ZIP code, derived from EIA-930 hourly fuel-mix data. Data lags up to about a day (not real-time). Returns time series with per-hour fuel mix, total generation, and carbon intensity. For timing and analysis (demand response, load shifting, grid patterns), not inventory reporting: it uses fixed per-fuel combustion factors on in-BA generation (no imports), so its values don't match eGRID's annual factors. For live or forecast intensity, WattTime or Electricity Maps are better options.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code (or use ba parameter)",
          "pattern": "^\\d{5}(-?\\d{4})?$"
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
        },
        "aggregate": {
          "type": "string",
          "enum": [
            "hour_of_day"
          ],
          "description": "Optional: return the 24-hour average profile over the last 7 days (168 hours) instead of the hourly series. Buckets are UTC hours; for a local-time scheduling window use cleanest_hours."
        }
      }
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "plant_emissions",
    "description": "Get emissions from EPA Clean Air Markets Division (CAMD) for a specific US power plant or a state: fossil units over 25 MW reporting to the Acid Rain Program and CSAPR. Per facility returns total CO2 (short tons), gross generation (MWh), heat input (mmBtu), NOx and SO2 (lb), primary fuel type, operating hours, and derived emissions rate (kg CO2/MWh). CAMD publishes by quarter, so the default window is the last 7 days of the latest published quarter (latest_published_date in the response); later dates are not available yet. Default output is a per-facility summary from daily data; format=hourly returns unit-hour records for small windows. Use for plant-specific carbon accounting, state-level fossil emissions and \"dirtiest plants in [state]\" queries.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "facility_id": {
          "type": "integer",
          "description": "EPA CAMD/ORIS facility code (e.g. 3 for Barry, AL). Find codes in the summary_by_facility of a state query, or at https://campd.epa.gov/."
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
          "description": "\"summary\" (default) aggregates by facility; \"hourly\" returns raw CAMD unit-hour records, about 0.8 KB each (a 9-unit plant-day was 172 KB), so use it with facility_id and 1-2 days."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 500,
          "description": "Summary only: return the top N facilities by CO2 (default 25); facilities_total gives the full count."
        }
      }
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "utility_tariff",
    "description": "Get the actual utility-specific electricity rate (not state average) for a US ZIP code or named utility. Returns the current default tariff with effective rate ($/kWh), fixed monthly charge, tier count, TOU indicator, and effective date. Data source: OpenEI URDB (NREL-hosted). With a ZIP, matches the ZIP's utility by EIA ID. Returns currently-effective tariffs; when URDB has none flagged as default (common for Commercial/Industrial) it returns the most recent ones and says so in warnings, including when the newest available tariff has expired. Does not cover Texas retail electric providers (deregulated market) - use electricity_rate there.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code",
          "pattern": "^\\d{5}(-?\\d{4})?$"
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
            "Lighting",
            "RES",
            "COM",
            "IND"
          ],
          "description": "Default \"Residential\" (case-insensitive; RES/COM/IND codes accepted)"
        },
        "limit": {
          "type": "integer",
          "description": "Max tariffs to return (1-20, default 5)",
          "minimum": 1,
          "maximum": 20
        }
      }
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "electricity_rate",
    "description": "Get the latest monthly average retail electricity rate ($/kWh and cents/kWh) for any US ZIP code, broken out by sector (residential, commercial, industrial, etc.). Data is state-level from EIA Form 861 - a ballpark, not utility- or ZIP-specific tariffs (use utility_tariff for those).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code",
          "pattern": "^\\d{5}(-?\\d{4})?$"
        }
      },
      "required": [
        "zip"
      ]
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "compare_sites",
    "description": "Compare and rank 2-25 candidate US sites (ZIP codes) for a facility, data center or EV/flexible load on grid carbon and electricity cost in one call. Per site: eGRID CO2e kg/kWh (location-based), Green-e residual mix (market-based), carbon-free %, $/kWh for the sector (the average of the ZIP's primary full-service utility - full-service first, then public power, IOU, co-op, the same heuristic as lookup's utility.primary - unless a delivery-only utility serves the ZIP (retail choice), else the state average; all EIA-861 2023, see rate_basis), and the cleanest daily window from the 7-day hourly profile of its balancing authority. With annual_kwh, also annual tCO2e and cost. Returns competition ranks by carbon, cost and combined, gap percentages, and best_* = null with *_tied lists when sites tie.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zips": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^\\d{5}(-?\\d{4})?$"
          },
          "minItems": 2,
          "maxItems": 25,
          "description": "Candidate US ZIP codes (5 digits or ZIP+4)"
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
            "ALL",
            "Commercial",
            "Industrial",
            "Residential"
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
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "cleanest_hours",
    "description": "Find the cleanest (lowest grid carbon) contiguous window of N hours in the day to run a flexible load (batch jobs, EV charging, pumping, HVAC pre-cooling) at a US ZIP code or balancing authority. Based on the hour-of-day pattern of the last 7 days (168 hours) of EIA-930 data, in local time. Returns the cleanest and dirtiest windows, % saved vs the daily average, and all hours ranked. A scheduling guide from recent history, not a forecast.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "zip": {
          "type": "string",
          "description": "5-digit US ZIP code (or use ba)",
          "pattern": "^\\d{5}(-?\\d{4})?$"
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
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "calculate_fuel_emissions",
    "description": "Calculate Scope 1 stationary-combustion emissions (CO2, CH4, N2O and CO2e) for fuels burned on site, using the GHG Emission Factors Hub 2026 (Cornerstone, successor to EPA's Hub; IPCC AR6 GWPs) by default, or EPA's 2025 edition (AR5) with edition=2025. Pass one or more items with fuel, quantity and unit, e.g. natural gas in therms/ccf/mcf/scf, propane/diesel/heating oil in gallons, coal in short tons. Biomass CO2 is reported separately (biogenic). Stationary sources only: for vehicle fuel the CO2 per gallon is the same, but CH4/N2O factors differ and are not included. Returns per-item and total CO2e. Pair with calculate_emissions for a facility's electricity (Scope 2).",
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
                "description": "Fuel id or alias: natural_gas, propane, diesel, heating_oil, gasoline, lpg, kerosene, jet_fuel, residual_fuel_oil_no_6, bituminous, wood, biodiesel... (63 Hub fuels)"
              },
              "quantity": {
                "type": "number",
                "minimum": 0
              },
              "unit": {
                "type": "string",
                "description": "Required: mmBtu, therm, Dth, scf, ccf, mcf, gallon, liter, barrel, short_ton, lb, tonne"
              }
            },
            "required": [
              "fuel",
              "quantity",
              "unit"
            ]
          }
        },
        "edition": {
          "type": "string",
          "enum": [
            "2026",
            "2025"
          ],
          "description": "Hub edition: 2026 (default; Cornerstone, AR6 GWPs) or 2025 (EPA, AR5 GWPs). Fuel factors are the same; CO2e differs slightly."
        }
      },
      "required": [
        "items"
      ]
    },
    "annotations": {
      "readOnlyHint": true
    }
  }
];

const server = new Server(
  { name: 'emission-factors', version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function zip5(v: unknown): string {
  // JSON numbers lose leading zeros (2108 for 02108): pad numbers, as the API does.
  const m = (typeof v === 'number' ? String(v).padStart(5, '0') : String(v ?? '').trim()).match(/^(\d{5})(?:-?\d{4})?$/);
  if (!m) throw new McpError(ErrorCode.InvalidParams, `zip must be a 5-digit US ZIP code (or ZIP+4), got "${v ?? ''}"`);
  return m[1];
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  // Reject arguments the tool does not declare (e.g. unit: "MWh" on calculate_emissions), as the hosted server does.
  const tool = TOOLS.find(t => t.name === name);
  const allowed = Object.keys((tool?.inputSchema as { properties?: object } | undefined)?.properties ?? {});
  const unknown = tool ? Object.keys(a).filter(k => !allowed.includes(k)) : [];
  if (unknown.length) return { isError: true, content: [{ type: 'text', text: `Error calling ${name}: Unknown argument(s) for ${name}: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}` }] };

  try {
    let result: unknown;
    switch (name) {
      case 'lookup_emission_factor': {
        const yq = a.year != null ? `&year=${encodeURIComponent(String(a.year))}` : '';
        result = await api(`/api/lookup?zip=${zip5(a.zip)}${yq}`);
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
        const zips = Array.isArray(a.zips) ? a.zips : []; // the API pads JSON numbers and validates
        if (zips.length === 0) throw new McpError(ErrorCode.InvalidParams, 'zips must be a non-empty array');
        if (zips.length > 100) throw new McpError(ErrorCode.InvalidParams, 'zips array exceeds 100 items');
        const full = a.full === true || a.full === 'true';
        result = await api('/api/lookup/batch', { method: 'POST', body: JSON.stringify({ zips, compact: !full, envelope: true }) });
        break;
      }
      case 'calculate_emissions': {
        const zip = zip5(a.zip);
        // Pass kwh and renewable_kwh through unchanged so the API rejects "", "abc" and the like.
        const year = a.year == null ? undefined : String(a.year);
        result = await api('/api/calculate', { method: 'POST', body: JSON.stringify({ zip, kwh: a.kwh, renewable_kwh: a.renewable_kwh, year }) });
        break;
      }
      case 'hourly_intensity': {
        const qs = new URLSearchParams();
        if (a.zip) qs.set('zip', zip5(a.zip));
        else if (a.ba) qs.set('ba', String(a.ba).toUpperCase());
        else throw new McpError(ErrorCode.InvalidParams, 'provide either zip or ba');
        if (a.hours != null) qs.set('hours', String(a.hours));
        if (a.aggregate) qs.set('aggregate', String(a.aggregate));
        result = await api(`/api/intensity?${qs}`);
        break;
      }
      case 'plant_emissions': {
        const qs = new URLSearchParams();
        if (a.facility_id != null) qs.set('facility_id', String(Number(a.facility_id)));
        else if (a.state) qs.set('state', String(a.state).toUpperCase());
        else throw new McpError(ErrorCode.InvalidParams, 'provide facility_id or state (optionally with days, or begin and end)');
        if (a.days != null) qs.set('days', String(a.days));
        if (a.begin) qs.set('begin', String(a.begin));
        if (a.end) qs.set('end', String(a.end));
        if (a.format) qs.set('format', String(a.format));
        if (a.limit != null) qs.set('limit', String(a.limit));
        result = await api(`/api/plant-emissions?${qs}`);
        break;
      }
      case 'utility_tariff': {
        const qs = new URLSearchParams();
        if (a.zip) qs.set('zip', zip5(a.zip));
        if (a.utility) qs.set('utility', String(a.utility));
        if (a.eiaid != null) qs.set('eiaid', String(Number(a.eiaid)));
        if (a.sector) qs.set('sector', String(a.sector));
        if (a.limit != null) qs.set('limit', String(a.limit));
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
        const zips = Array.isArray(a.zips) ? a.zips : []; // the API pads JSON numbers and validates
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
        result = await api('/api/fuel-emissions', { method: 'POST', body: JSON.stringify({ items, ...(a.edition != null ? { edition: String(a.edition) } : {}) }) });
        break;
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    // Argument errors go back as an isError tool result, which clients show the model.
    if (err instanceof McpError && err.code === ErrorCode.InvalidParams) {
      return { isError: true, content: [{ type: 'text', text: `Error calling ${name}: ${err.message.replace(/^MCP error -?\d+: /, '')}` }] };
    }
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
