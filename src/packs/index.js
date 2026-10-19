// Registry of country packs. To support a new country, add a file shaped like
// ca.js / kz.js / cn.js and register it here. No engine code changes.
import CA from "./ca.js";
import KZ from "./kz.js";
import CN from "./cn.js";

export const PACKS = { CA, KZ, CN };

export function getPack(code) {
  const p = PACKS[code];
  if (!p) throw new Error(`No country pack for ${code}`);
  return p;
}

export function packForCurrency(cur) {
  return Object.values(PACKS).find((p) => p.currency === cur) || null;
}
