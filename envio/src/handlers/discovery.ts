import { indexer, type EvmOnEventContext } from "envio";
import { tokenMetadata } from "../lib/metadata";
import {
  accountTokenId,
  interactions,
  nftOwner,
  type Standard,
} from "../lib/standards";

type Context = EvmOnEventContext;

// A Token row exists once any recognised Transfer produced an interaction.
// Metadata is read once, when the row is created.
async function ensureToken(context: Context, id: string, block: number) {
  if (await context.Token.get(id)) return;
  const meta = await context.effect(tokenMetadata, id);
  context.Token.set({
    id,
    firstSeenBlock: block,
    name: meta.name ?? undefined,
    symbol: meta.symbol ?? undefined,
    decimals: meta.decimals ?? undefined,
    metadataStatus: "FETCHED",
  });
}

async function touch(
  context: Context,
  standard: Standard,
  token: string,
  account: string,
  direction: "in" | "out",
  block: number,
) {
  const id = accountTokenId(account, token, standard);
  const row = await context.AccountToken.get(id);
  // A self-transfer arrives as two interactions for one id, so both counters move.
  context.AccountToken.set({
    id,
    account,
    token_id: token,
    standard,
    firstSeenBlock: row ? Math.min(row.firstSeenBlock, block) : block,
    lastSeenBlock: row ? Math.max(row.lastSeenBlock, block) : block,
    sentCount: (row?.sentCount ?? 0) + (direction === "out" ? 1 : 0),
    receivedCount: (row?.receivedCount ?? 0) + (direction === "in" ? 1 : 0),
  });
}

async function apply(
  context: Context,
  standard: Standard,
  token: string,
  items: ReturnType<typeof interactions>,
  block: number,
) {
  if (items.length === 0) return;
  await ensureToken(context, token, block);
  for (const i of items) {
    await touch(context, standard, token, i.account, i.direction, block);
  }
}

indexer.onEvent(
  { contract: "ERC20", event: "Transfer", wildcard: true },
  async ({ event, context }) => {
    const { from, to, value } = event.params;
    await apply(
      context,
      "ERC20",
      event.srcAddress,
      interactions(from, to, value === 0n),
      event.block.number,
    );
  },
);

indexer.onEvent(
  { contract: "ERC721", event: "Transfer", wildcard: true },
  async ({ event, context }) => {
    const { from, to, tokenId } = event.params;
    const token = event.srcAddress;
    const items = interactions(from, to, false);
    await apply(context, "ERC721", token, items, event.block.number);
    if (items.length === 0) return;
    context.NftItem.set({
      id: `${token}:${tokenId}`,
      contract_id: token,
      tokenId,
      owner: nftOwner(items),
      lastTransferBlock: event.block.number,
    });
  },
);
