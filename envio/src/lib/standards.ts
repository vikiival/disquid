// Pure interaction logic, ported from the squid's src/standards and
// src/discovery/aggregate.ts.
export const ZERO_ADDRESS = "0x" + "0".repeat(40);

export type Standard = "ERC20" | "ERC721";
export type Direction = "in" | "out";

export interface Interaction {
  account: string;
  direction: Direction;
}

export const standardCode = (s: Standard) => (s === "ERC20" ? 20 : 721);

export const accountTokenId = (account: string, token: string, s: Standard) =>
  `${account}:${token}:${standardCode(s)}`;

/**
 * Who sent and received. The zero address is not an account (mint/burn), but
 * the other side still interacted. A zero-value ERC-20 Transfer is skipped:
 * it moves no balance and is the main address-poisoning vector.
 */
export function interactions(
  from: string,
  to: string,
  zeroValue: boolean,
): Interaction[] {
  if (zeroValue) return [];
  const out: Interaction[] = [];
  if (from !== ZERO_ADDRESS) out.push({ account: from, direction: "out" });
  if (to !== ZERO_ADDRESS) out.push({ account: to, direction: "in" });
  return out;
}

/** Owner after an ERC-721 Transfer: 'in' wins; 'out' alone is a burn. */
export function nftOwner(items: Interaction[]): string {
  let owner = ZERO_ADDRESS;
  for (const i of items) owner = i.direction === "in" ? i.account : ZERO_ADDRESS;
  return owner;
}
