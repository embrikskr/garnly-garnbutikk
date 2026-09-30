/**
 * CORS for endepunktene butikkpanelet kaller fra nettleseren.
 *
 * PANEL_ORIGIN er en kommaliste. Står den tom, slipper alle til – greit i test, men i drift
 * skal den settes: endepunktene her svarer på en bruker-JWT, og en fremmed side som kan lese
 * svaret ville sett butikkens ordrer.
 */
const ALLOWED = (Deno.env.get("PANEL_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

export function cors(req: Request, methods = "POST, OPTIONS"): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.includes("*") ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
