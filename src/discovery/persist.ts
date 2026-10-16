import {In, LessThan} from 'typeorm'

import type {MetadataResult} from '../metadata'
import {AccountToken, Block, Token, TokenMetadataStatus} from '../model'
import type {Fold} from './aggregate'

// The slice of the typeorm-store Store that discovery needs. Keeping it narrow lets tests use an
// in-memory fake, and every write still goes through the real store so hot rollback sees it.
export interface DiscoveryStore {
    findBy<E extends {id: string}>(entityClass: new () => E, where: any): Promise<E[]>
    find<E extends {id: string}>(entityClass: new () => E, options?: any): Promise<E[]>
    insert<E extends {id: string}>(entities: E[]): Promise<void>
    upsert<E extends {id: string}>(entities: E[]): Promise<void>
    remove<E extends {id: string}>(entityClass: new () => E, id: string | string[]): Promise<void>
}

// Implemented by MetadataLoader. fetch never rejects; `sweepLimit` is 0 while the node is backing off.
export interface TokenMetadataSource {
    fetch(tokens: string[]): Promise<Map<string, MetadataResult>>
    sweepLimit(): number
}

export interface BlockHeaderLike {
    number: number
    hash: string
    timestamp: number // ms
}

export const CHUNK = 1000
export const PRUNE_EVERY = 1000
export const PRUNE_LIMIT = 10_000
export const DEFAULT_BLOCK_RETENTION = 50_000

export function blockId(n: number): string {
    return String(n).padStart(10, '0')
}

function chunks<T>(items: T[], size: number): T[][] {
    const result: T[][] = []
    for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
    return result
}

export interface TokenSummary {
    newTokens: number
    metadataFetched: number
    metadataPending: number
}

// Metadata is fetched before anything is written, so a new token is inserted complete (FETCHED)
// or PENDING after an RPC failure. PENDING tokens already in the DB are filled in here when the
// batch touches them, and by a bounded sweep that also backfills rows from before metadata existed.
export async function persistTokens(
    store: DiscoveryStore,
    tokens: Map<string, number>,
    metadata: TokenMetadataSource,
): Promise<TokenSummary> {
    let ids = [...tokens.keys()]
    let existing = new Map<string, Token>()
    for (let part of chunks(ids, CHUNK)) {
        for (let row of await store.findBy(Token, {id: In(part)})) existing.set(row.id, row)
    }
    let missing = ids.filter(id => !existing.has(id))

    let pending = new Map<string, Token>()
    for (let row of existing.values()) {
        if (row.metadataStatus === TokenMetadataStatus.PENDING) pending.set(row.id, row)
    }
    let sweep = metadata.sweepLimit()
    if (sweep > 0) {
        for (let row of await store.find(Token, {where: {metadataStatus: TokenMetadataStatus.PENDING}, take: sweep})) {
            pending.set(row.id, row)
        }
    }

    let results = await metadata.fetch([...missing, ...pending.keys()])
    let answered = (id: string) => {
        let result = results.get(id)
        return result != null && result !== 'retry'
    }
    let apply = (id: string, firstSeenBlock: number) => {
        let result = results.get(id) ?? 'retry'
        return new Token(
            result === 'retry'
                ? {id, firstSeenBlock, metadataStatus: TokenMetadataStatus.PENDING}
                : {id, firstSeenBlock, ...result, metadataStatus: TokenMetadataStatus.FETCHED},
        )
    }

    for (let part of chunks(missing, CHUNK)) {
        await store.insert(part.map(id => apply(id, tokens.get(id)!)))
    }
    // Still-PENDING rows are unchanged, so only the answered ones are written.
    let filled = [...pending.values()].filter(row => answered(row.id)).map(row => apply(row.id, row.firstSeenBlock))
    for (let part of chunks(filled, CHUNK)) await store.upsert(part)

    let metadataFetched = filled.length + missing.filter(answered).length
    return {
        newTokens: missing.length,
        metadataFetched,
        metadataPending: results.size - metadataFetched,
    }
}

export async function persistAccountTokens(store: DiscoveryStore, fold: Fold): Promise<number> {
    const ids = [...fold.pending.keys()]
    if (ids.length === 0) return 0
    const existing = new Map<string, AccountToken>()
    for (const part of chunks(ids, CHUNK)) {
        for (const row of await store.findBy(AccountToken, {id: In(part)})) existing.set(row.id, row)
    }
    // Fresh entities, not the loaded ones: loaded rows carry no `token` relation and the upsert
    // must write the FK column.
    const rows = ids.map(id => {
        const value = fold.pending.get(id)!
        const old = existing.get(id)
        return new AccountToken({
            id,
            account: value.account,
            token: new Token({id: value.token}),
            standard: value.standard,
            firstSeenBlock: old == null ? value.firstSeenBlock : Math.min(old.firstSeenBlock, value.firstSeenBlock),
            lastSeenBlock: old == null ? value.lastSeenBlock : Math.max(old.lastSeenBlock, value.lastSeenBlock),
            sentCount: (old?.sentCount ?? 0) + value.sentCount,
            receivedCount: (old?.receivedCount ?? 0) + value.receivedCount,
        })
    })
    await store.upsert(rows)
    return rows.length
}

export async function persistBlocks(store: DiscoveryStore, headers: BlockHeaderLike[]): Promise<void> {
    if (headers.length === 0) return
    await store.upsert(
        headers.map(
            h => new Block({id: blockId(h.number), number: h.number, hash: h.hash, timestamp: new Date(h.timestamp)}),
        ),
    )
}

// Pruning is a DELETE per batch otherwise, so it only runs when the batch contains a multiple of
// PRUNE_EVERY. The number index makes the lookup cheap; PRUNE_LIMIT bounds one pass.
export function shouldPrune(first: number, last: number): boolean {
    return Math.floor(last / PRUNE_EVERY) > Math.floor((first - 1) / PRUNE_EVERY)
}

export async function pruneBlocks(
    store: DiscoveryStore,
    first: number,
    last: number,
    retention: number,
): Promise<number> {
    if (!shouldPrune(first, last)) return 0
    const cutoff = last - retention
    if (cutoff <= 0) return 0
    const old = await store.find(Block, {
        where: {number: LessThan(cutoff)},
        order: {number: 'ASC'},
        take: PRUNE_LIMIT,
    })
    if (old.length === 0) return 0
    await store.remove(
        Block,
        old.map(b => b.id),
    )
    return old.length
}

export function blockRetention(env: NodeJS.ProcessEnv = process.env): number {
    const value = Number(env.BLOCK_RETENTION ?? DEFAULT_BLOCK_RETENTION)
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_BLOCK_RETENTION
}

export interface PersistSummary extends TokenSummary {
    accountTokens: number
    pruned: number
}

export async function persistBatch(
    store: DiscoveryStore,
    fold: Fold,
    headers: BlockHeaderLike[],
    retention: number,
    metadata: TokenMetadataSource,
): Promise<PersistSummary> {
    const tokens = await persistTokens(store, fold.tokens, metadata)
    const accountTokens = await persistAccountTokens(store, fold)
    await persistBlocks(store, headers)
    let pruned = 0
    if (headers.length > 0) {
        pruned = await pruneBlocks(store, headers[0].number, headers[headers.length - 1].number, retention)
    }
    return {...tokens, accountTokens, pruned}
}
