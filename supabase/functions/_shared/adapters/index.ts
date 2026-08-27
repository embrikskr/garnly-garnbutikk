import type { PosAdapter } from "./types.ts";
import { duellAdapter } from "./duell.ts";
import { mystoreAdapter } from "./mystore.ts";
import { csvAdapter } from "./csv.ts";

const registry: Record<string, PosAdapter> = {
  duell: duellAdapter,
  mystore: mystoreAdapter,
  csv: csvAdapter,
};

export function getAdapter(system: string): PosAdapter {
  const a = registry[system];
  if (!a) throw new Error(`Ingen adapter for kassesystem "${system}"`);
  return a;
}

export { AdapterError } from "./types.ts";
