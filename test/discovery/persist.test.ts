import {describe, expect, it, vi} from 'vitest'

import {
    aggregate,
    blockId,
    blockRetention,
    persistAccountTokens,
    persistBatch,
    persistBlocks,
    persistTokens,
    pruneBlocks,
    shouldPrune,
} from '../../src/discovery'
import {MetadataLoader} from '../../src/metadata'
import {AccountToken, Block, NftItem, Token, TokenMetadataStatus, TokenStandard} from '../../src/model'
import {TRANSFER_TOPIC} from '../../src/standards'
import {abiString, decimalsWord, downError, FakeMetadataNode} from '../metadata/fake-node'
import {FakeStore} from './fake-store'


const word = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0')
const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const T1 = '0x' + '1'.repeat(40)
const T2 = '0x' + '2'.repeat(40)
const DATA = '0x' + '0'.repeat(63) + '1'
const transfer = (token: string, from: string, to: string) => ({
    address: token,
    topics: [TRANSFER_TOPIC, word(from), word(to)],
    data: DATA,
})
const erc721Transfer = (token: string, from: string, to: string, tokenId: bigint) => ({
    address: token,
    topics: [TRANSFER_TOPIC, word(from), word(to), '0x' + tokenId.toString(16).padStart(64, '0')],
    data: '0x',
})
// Answers every token like an EOA: FETCHED with null fields.
const metadata = () =>
    new MetadataLoader(new FakeMetadataNode(), {batchSize: 50, sweepLimit: 200, retryBackoffMs: 60_000, multicallAddress: '0xca11bde05977b3631167028862be2a173976ca11'})
const header = (number: number) => ({number, hash: '0x' + number.toString(16).padStart(64, '0'), timestamp: number * 1000})

describe('persistTokens', () => {
    it('inserts only the missing tokens with their first seen block', async () => {
        const store = new FakeStore()
        await store.insert([new Token({id: T1, firstSeenBlock: 1, metadataStatus: TokenMetadataStatus.FETCHED})])
        store.calls.length = 0
        const summary = await persistTokens(
            store,
            new Map([
                [T1, 50],
                [T2, 60],
            ]),
            metadata(),
        )
        expect(summary.newTokens).toBe(1)
        expect(store.table(Token).get(T1)!.firstSeenBlock).toBe(1)
        expect(store.table(Token).get(T2)!.firstSeenBlock).toBe(60)
        expect(store.calls.filter(c => c.method === 'insert')).toEqual([{method: 'insert', entity: 'Token', count: 1}])
    })

    it('chunks lookups by 1000', async () => {
        const store = new FakeStore()
        const tokens = new Map<string, number>()
        for (let i = 0; i < 2500; i++) tokens.set('0x' + i.toString(16).padStart(40, '0'), i)
        await persistTokens(store, tokens, metadata())
        expect(store.calls.filter(c => c.method === 'findBy')).toHaveLength(3)
        expect(store.table(Token).size).toBe(2500)
    })
})

describe('persistAccountTokens', () => {
    it('merges with existing rows: min first, max last, counts added', async () => {
        const store = new FakeStore()
        await store.insert([new Token({id: T1, firstSeenBlock: 100, metadataStatus: TokenMetadataStatus.FETCHED})])
        await store.upsert([
            new AccountToken({
                id: `${A}:${T1}:20`,
                account: A,
                token: new Token({id: T1}),
                standard: TokenStandard.ERC20,
                firstSeenBlock: 100,
                lastSeenBlock: 110,
                sentCount: 2,
                receivedCount: 3,
            }),
        ])
        const fold = aggregate([
            {header: {number: 120}, logs: [transfer(T1, A, B)]},
            {header: {number: 121}, logs: [transfer(T1, A, A)]},
        ])
        store.calls.length = 0
        await persistAccountTokens(store, fold)

        expect(store.calls.filter(c => c.method === 'upsert')).toEqual([{method: 'upsert', entity: 'AccountToken', count: 2}])
        const merged = store.table(AccountToken).get(`${A}:${T1}:20`)!
        expect(merged).toMatchObject({firstSeenBlock: 100, lastSeenBlock: 121, sentCount: 4, receivedCount: 4})
        expect(merged.token.id).toBe(T1)
        const fresh = store.table(AccountToken).get(`${B}:${T1}:20`)!
        expect(fresh).toMatchObject({firstSeenBlock: 120, lastSeenBlock: 120, sentCount: 0, receivedCount: 1})
    })

    it('does nothing for an empty fold', async () => {
        const store = new FakeStore()
        await persistAccountTokens(store, aggregate([{header: {number: 1}, logs: []}]))
        expect(store.calls).toEqual([])
    })
})

describe('blocks', () => {
    it('upserts every header with padded id and ms timestamp', async () => {
        const store = new FakeStore()
        await persistBlocks(store, [header(42), header(43)])
        const row = store.table(Block).get('0000000042')!
        expect(row).toMatchObject({number: 42, hash: header(42).hash})
        expect(row.timestamp).toEqual(new Date(42_000))
        expect(blockId(26_104_555)).toBe('0026104555')
    })

    it('decides when a batch crosses a multiple of 1000', () => {
        expect(shouldPrune(1, 999)).toBe(false)
        expect(shouldPrune(1, 1000)).toBe(true)
        expect(shouldPrune(1000, 1000)).toBe(true)
        expect(shouldPrune(1001, 1999)).toBe(false)
        expect(shouldPrune(1999, 2001)).toBe(true)
    })

    it('prunes strictly below head - retention, only on a crossing batch', async () => {
        const store = new FakeStore()
        await persistBlocks(
            store,
            Array.from({length: 40}, (_, i) => header(1000 + i)),
        )
        // head 1039, retention 10 -> cutoff 1029: keep >= 1029.
        expect(await pruneBlocks(store, 1030, 1039, 10)).toBe(0) // no multiple of 1000 in batch
        expect(store.table(Block).size).toBe(40)
        expect(await pruneBlocks(store, 1000, 1039, 10)).toBe(29)
        const numbers = [...store.table(Block).values()].map(b => b.number).sort()
        expect(numbers[0]).toBe(1029)
        expect(numbers).toHaveLength(11)
    })

    it('does not prune when the window is shorter than the retention', async () => {
        const store = new FakeStore()
        await persistBlocks(store, [header(900), header(1000)])
        expect(await pruneBlocks(store, 999, 1000, 50_000)).toBe(0)
        expect(store.table(Block).size).toBe(2)
    })

    it('parses BLOCK_RETENTION with a default', () => {
        expect(blockRetention({})).toBe(50_000)
        expect(blockRetention({BLOCK_RETENTION: '123'})).toBe(123)
        expect(blockRetention({BLOCK_RETENTION: 'nope'})).toBe(50_000)
    })
})

describe('persistBatch', () => {
    it('writes tokens, account tokens and blocks together', async () => {
        const store = new FakeStore()
        const blocks = [
            {header: header(1000), logs: [transfer(T1, A, B)]},
            {header: header(1001), logs: []},
        ]
        const summary = await persistBatch(store, aggregate(blocks), blocks.map(b => b.header), 50_000, metadata())
        expect(summary).toEqual({newTokens: 1, metadataFetched: 1, metadataPending: 0, accountTokens: 2, nftItems: 0, pruned: 0})
        expect(store.table(Block).size).toBe(2)
        // FK order: token rows land before account-token rows.
        const order = store.calls.filter(c => !c.method.startsWith('find')).map(c => c.entity)
        expect(order).toEqual(['Token', 'AccountToken', 'Block'])
    })

    it('writes nft items after their token row', async () => {
        const store = new FakeStore()
        const blocks = [{header: header(1002), logs: [erc721Transfer(T1, A, B, 5n)]}]
        const summary = await persistBatch(store, aggregate(blocks), blocks.map(b => b.header), 50_000, metadata())
        expect(summary).toMatchObject({newTokens: 1, accountTokens: 2, nftItems: 1})
        // The NftItem's token FK must reference an existing Token row.
        expect(store.table(Token).get(T1)).toMatchObject({firstSeenBlock: 1002})
        expect(store.table(NftItem).get(`${T1}:5`)).toEqual(
            expect.objectContaining({tokenId: 5n, owner: B, lastTransferBlock: 1002}),
        )
        const order = store.calls.filter(c => !c.method.startsWith('find')).map(c => c.entity)
        expect(order).toEqual(['Token', 'AccountToken', 'NftItem', 'Block'])
    })
})

describe('token metadata', () => {
    const loader = (node: FakeMetadataNode, now = () => 0) =>
        new MetadataLoader(node, {batchSize: 50, sweepLimit: 200, retryBackoffMs: 60_000, multicallAddress: '0xca11bde05977b3631167028862be2a173976ca11'}, now)
    const usdt = {name: abiString('Tether USD'), symbol: abiString('USDT'), decimals: decimalsWord(6n)}

    it('inserts a new token already FETCHED', async () => {
        const store = new FakeStore()
        const summary = await persistTokens(store, new Map([[T1, 7]]), loader(new FakeMetadataNode({[T1]: usdt})))
        expect(store.table(Token).get(T1)).toMatchObject({
            firstSeenBlock: 7,
            name: 'Tether USD',
            symbol: 'USDT',
            decimals: 6,
            metadataStatus: TokenMetadataStatus.FETCHED,
        })
        expect(summary).toMatchObject({newTokens: 1, metadataFetched: 1, metadataPending: 0})
    })

    it('inserts PENDING while the node is down, then the sweep backfills it and legacy rows', async () => {
        const store = new FakeStore()
        const node = new FakeMetadataNode({[T1]: usdt, [T2]: usdt})
        let now = 0
        const metadata = loader(node, () => now)
        node.fail = downError()
        await persistTokens(store, new Map([[T1, 7]]), metadata)
        expect(store.table(Token).get(T1)).toMatchObject({name: undefined, metadataStatus: TokenMetadataStatus.PENDING})

        // A row from before metadata existed, and an empty batch that touches neither token.
        await store.insert([new Token({id: T2, firstSeenBlock: 1, metadataStatus: TokenMetadataStatus.PENDING})])
        node.fail = undefined
        await persistTokens(store, new Map(), metadata) // still backing off: untouched
        expect(store.table(Token).get(T1)!.metadataStatus).toBe(TokenMetadataStatus.PENDING)

        now = 60_000
        const summary = await persistTokens(store, new Map(), metadata)
        expect(summary).toMatchObject({newTokens: 0, metadataFetched: 2})
        for (const id of [T1, T2]) {
            expect(store.table(Token).get(id)).toMatchObject({symbol: 'USDT', decimals: 6, metadataStatus: TokenMetadataStatus.FETCHED})
        }
        expect(store.table(Token).get(T1)!.firstSeenBlock).toBe(7)
    })
})
