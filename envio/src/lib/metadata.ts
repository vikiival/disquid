// Token name/symbol/decimals, read once per token at `latest` through Multicall3
// (the squid's MetadataLoader). Effect inputs arrive concurrently during the
// preload pass; a small micro-batcher folds them into one eth_call per
// BATCH tokens (3 sub-calls each), as the squid does.
import { createEffect, S } from "envio";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  http,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import {
  decodeDecimals,
  decodeLabel,
  MAX_NAME,
  MAX_SYMBOL,
  type TokenMetadata,
} from "./decode";

const DEFAULT_RPC = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
];
const urls = process.env.ENVIO_RPC_URL
  ? process.env.ENVIO_RPC_URL.split(",").map((u) => u.trim()).filter(Boolean)
  : DEFAULT_RPC;

const client = createPublicClient({
  chain: mainnet,
  transport: fallback(urls.map((url) => http(url, { retryCount: 4, timeout: 30_000 }))),
});

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
]);
const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const SELECTORS = ["name", "symbol", "decimals"].map((functionName) =>
  encodeFunctionData({ abi: erc20Abi, functionName: functionName as "name" }),
);

const BATCH = Number(process.env.METADATA_BATCH_SIZE ?? 50);
const FLUSH_MS = 20;
const EMPTY: TokenMetadata = { name: null, symbol: null, decimals: null };

type Waiter = {
  token: string;
  resolve: (m: TokenMetadata) => void;
  reject: (e: unknown) => void;
};
let queue: Waiter[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the EVM rejected the whole call (a hostile token burning gas), not the transport. */
const EXECUTION_ERROR =
  /execution reverted|out of gas|gas (required )?exceeds|exceeds? (the )?(block )?gas|gas (limit|cap)|intrinsic gas/i;

async function callBatch(tokens: string[]): Promise<TokenMetadata[]> {
  const calls = tokens.flatMap((target) =>
    SELECTORS.map((callData) => ({ target: target as `0x${string}`, allowFailure: true, callData })),
  );
  const data = encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [calls] });
  const res = await client.call({ to: MULTICALL3, data });
  const results = decodeFunctionResult({
    abi: multicallAbi,
    functionName: "aggregate3",
    data: res.data!,
  });
  const at = (i: number) => (results[i]!.success ? results[i]!.returnData : "0x");
  return tokens.map((_, i) => ({
    name: decodeLabel(at(3 * i), MAX_NAME),
    symbol: decodeLabel(at(3 * i + 1), MAX_SYMBOL),
    decimals: decodeDecimals(at(3 * i + 2)),
  }));
}

/** On an EVM-level failure bisect down to the offending token, which gets null metadata. */
async function load(tokens: string[]): Promise<TokenMetadata[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callBatch(tokens);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (EXECUTION_ERROR.test(msg)) {
        if (tokens.length === 1) return [EMPTY];
        const mid = tokens.length >> 1;
        return [...(await load(tokens.slice(0, mid))), ...(await load(tokens.slice(mid)))];
      }
      // Transport failure: back off and retry; after 8 tries the indexer stops
      // rather than record a token with missing metadata.
      if (attempt >= 8) throw err;
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
    }
  }
}

async function flush() {
  timer = undefined;
  const waiters = queue;
  queue = [];
  for (let i = 0; i < waiters.length; i += BATCH) {
    const part = waiters.slice(i, i + BATCH);
    load(part.map((w) => w.token)).then(
      (metas) => part.forEach((w, j) => w.resolve(metas[j]!)),
      (err) => part.forEach((w) => w.reject(err)),
    );
  }
}

function enqueue(token: string): Promise<TokenMetadata> {
  return new Promise((resolve, reject) => {
    queue.push({ token, resolve, reject });
    if (queue.length >= BATCH) {
      if (timer) clearTimeout(timer);
      void flush();
    } else if (!timer) {
      timer = setTimeout(flush, FLUSH_MS);
    }
  });
}

export const tokenMetadata = createEffect(
  {
    name: "tokenMetadata",
    input: S.string,
    output: {
      name: S.nullable(S.string),
      symbol: S.nullable(S.string),
      decimals: S.nullable(S.number),
    },
    cache: true,
    rateLimit: false,
  },
  async ({ input: token }) => enqueue(token),
);
