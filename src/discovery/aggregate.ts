import {ZERO_ADDRESS, accountTokenId, decodeLog} from '../standards'
import type {Interaction, RawLog} from '../standards'
import type {TokenStandard} from '../model'

export interface Pending {
    account: string
    token: string
    standard: TokenStandard
    firstSeenBlock: number
    lastSeenBlock: number
    sentCount: number
    receivedCount: number
}

export interface BlockWithLogs {
    header: {number: number}
    logs: RawLog[]
}

export interface Fold {
    pending: Map<string, Pending>
    // Lowest block, within this batch, that touched each token address.
    tokens: Map<string, number>
    // Latest ERC-721 transfer per (contract, tokenId) within this batch; when a
    // token moves several times, the last processed transfer wins ("last to wins").
    nft: Map<string, NftMove>
}

export interface NftMove {
    contract: string // lowercase 0x address
    tokenId: bigint
    owner: string // lowercase 0x address; the zero address after a burn
    block: number
}

export function emptyFold(): Fold {
    return {pending: new Map(), tokens: new Map(), nft: new Map()}
}

export function addInteraction(fold: Fold, i: Interaction): void {
    const id = accountTokenId(i.account, i.token, i.standard)
    let row = fold.pending.get(id)
    if (row == null) {
        row = {
            account: i.account,
            token: i.token,
            standard: i.standard,
            firstSeenBlock: i.block,
            lastSeenBlock: i.block,
            sentCount: 0,
            receivedCount: 0,
        }
        fold.pending.set(id, row)
    } else {
        row.firstSeenBlock = Math.min(row.firstSeenBlock, i.block)
        row.lastSeenBlock = Math.max(row.lastSeenBlock, i.block)
    }
    // A self-transfer arrives as two interactions for the same id, so both counters move.
    if (i.direction === 'out') row.sentCount += 1
    else row.receivedCount += 1

    const first = fold.tokens.get(i.token)
    if (first == null || i.block < first) fold.tokens.set(i.token, i.block)

    // An ERC-20 Transfer carries no tokenId and folds into AccountToken only. For
    // ERC-721 both interactions of one log (out/in) carry the same tokenId, so the
    // last processed one sets the owner: 'in' wins for a transfer, 'out' alone
    // means burn (owner back to the zero address), 'in' alone means mint.
    if (i.tokenId != null) {
        fold.nft.set(`${i.token}:${i.tokenId}`, {
            contract: i.token,
            tokenId: i.tokenId,
            owner: i.direction === 'in' ? i.account : ZERO_ADDRESS,
            block: i.block,
        })
    }
}

export function aggregate(blocks: BlockWithLogs[]): Fold {
    const fold = emptyFold()
    for (const block of blocks) {
        for (const log of block.logs) {
            for (const interaction of decodeLog(log, block.header.number)) {
                addInteraction(fold, interaction)
            }
        }
    }
    return fold
}
