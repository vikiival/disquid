import { describe, expect, it } from "vitest";
import { decodeDecimals, decodeLabel, MAX_NAME } from "../src/lib/decode";
import {
  accountTokenId,
  interactions,
  nftOwner,
  ZERO_ADDRESS,
} from "../src/lib/standards";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const T = "0x" + "c".repeat(40);

describe("interactions", () => {
  it("records sender as out and recipient as in", () => {
    expect(interactions(A, B, false)).toEqual([
      { account: A, direction: "out" },
      { account: B, direction: "in" },
    ]);
  });

  it("treats the zero address as a non-account on mint and burn", () => {
    expect(interactions(ZERO_ADDRESS, B, false)).toEqual([{ account: B, direction: "in" }]);
    expect(interactions(A, ZERO_ADDRESS, false)).toEqual([{ account: A, direction: "out" }]);
    expect(interactions(ZERO_ADDRESS, ZERO_ADDRESS, false)).toEqual([]);
  });

  it("skips zero-value transfers (address poisoning)", () => {
    expect(interactions(A, B, true)).toEqual([]);
  });

  it("gives a self-transfer both directions for one account", () => {
    const items = interactions(A, A, false);
    expect(items.map((i) => i.direction)).toEqual(["out", "in"]);
    expect(new Set(items.map((i) => i.account)).size).toBe(1);
  });
});

describe("nftOwner", () => {
  it("is the recipient of a transfer or mint", () => {
    expect(nftOwner(interactions(A, B, false))).toBe(B);
    expect(nftOwner(interactions(ZERO_ADDRESS, B, false))).toBe(B);
  });
  it("is the zero address after a burn", () => {
    expect(nftOwner(interactions(A, ZERO_ADDRESS, false))).toBe(ZERO_ADDRESS);
  });
});

describe("ids", () => {
  it("encodes the standard code", () => {
    expect(accountTokenId(A, T, "ERC20")).toBe(`${A}:${T}:20`);
    expect(accountTokenId(A, T, "ERC721")).toBe(`${A}:${T}:721`);
  });
});

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const abiString = (s: string) => {
  const hex = Buffer.from(s).toString("hex");
  return "0x" + word(32n) + word(BigInt(s.length)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
};

describe("metadata decoding", () => {
  it("reads a string, falling back to bytes32", () => {
    expect(decodeLabel(abiString("Tether USD"), 128)).toBe("Tether USD");
    expect(decodeLabel("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0"), 64)).toBe("MKR");
  });
  it("strips control characters, caps length and maps empty to null", () => {
    expect(decodeLabel(abiString("  A\u0000B\u0007C \n"), 64)).toBe("ABC");
    expect(decodeLabel(abiString("x".repeat(500)), MAX_NAME)).toHaveLength(MAX_NAME);
    expect(decodeLabel("0x", 64)).toBeNull();
    expect(decodeLabel("0x" + "ff".repeat(100), 64)).toBeNull();
  });
  it("accepts decimals up to 255 only", () => {
    expect(decodeDecimals("0x" + word(18n))).toBe(18);
    expect(decodeDecimals("0x" + word(255n))).toBe(255);
    expect(decodeDecimals("0x" + word(256n))).toBeNull();
    expect(decodeDecimals("0x12")).toBeNull();
  });
});
