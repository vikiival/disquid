// Ported from the squid's src/metadata/decode.ts: same cleaning and limits.
import { decodeAbiParameters } from "viem";

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
}

export const MAX_NAME = 128;
export const MAX_SYMBOL = 64;

// Postgres text rejects \0, and control characters have no place in a label.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(value: string, max: number): string | null {
  const text = [...value.replace(CONTROL, "").trim()].slice(0, max).join("").trim();
  return text === "" ? null : text;
}

/** name()/symbol() return data: a `string`, or the bytes32 that MKR-style tokens return. */
export function decodeLabel(returnData: string, max: number): string | null {
  const bytes = (returnData.length - 2) / 2;
  try {
    if (bytes === 32) {
      return clean(Buffer.from(returnData.slice(2), "hex").toString("utf8"), max);
    }
    if (bytes < 64) return null;
    const [s] = decodeAbiParameters([{ type: "string" }], returnData as `0x${string}`);
    return clean(s, max);
  } catch {
    return null;
  }
}

/** A uint256 word that fits in uint8; anything larger is a misbehaving token. */
export function decodeDecimals(returnData: string): number | null {
  if (returnData.length < 66) return null;
  const value = BigInt("0x" + returnData.slice(2, 66));
  return value <= 255n ? Number(value) : null;
}
