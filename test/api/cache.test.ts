import {describe, expect, it} from 'vitest'
import {BalanceCache, LruMap} from '../../src/server-extension/balances/cache'
import {balanceConfigFromEnv} from '../../src/server-extension/balances/config'
import {BalanceService} from '../../src/server-extension/balances/service'
import {addr, FakeMulticallNode, hash} from './fakes'

const ALICE = addr(0xa11ce)
const TOKEN = addr(1)
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

describe('LruMap', () => {
    it('evicts the least recently used key', () => {
        let lru = new LruMap<string, number>(2)
        lru.set('a', 1)
        lru.set('b', 2)
        lru.get('a')
        lru.set('c', 3)
        expect(lru.get('b')).toBeUndefined()
        expect(lru.get('a')).toBe(1)
        expect(lru.get('c')).toBe(3)
        expect(lru.size).toBe(2)
    })
})

describe('BalanceCache', () => {
    function setup(now = {t: 0}) {
        let cache = new BalanceCache({
            maxEntries: 100,
            maxAgeMs: 1000,
            alwaysRefresh: new Set([WETH]),
            now: () => now.t,
        })
        return {cache, now}
    }

    it('serves an entry only while no transfer happened after its block', () => {
        let {cache} = setup()
        cache.store(ALICE, TOKEN, 5n, 100, hash(100))
        expect(cache.candidates(ALICE, [{token: TOKEN, lastSeenBlock: 100}], 120).get(TOKEN)?.balance).toBe(5n)
        expect(cache.candidates(ALICE, [{token: TOKEN, lastSeenBlock: 101}], 120).size).toBe(0)
    })

    it('never serves a read from a block after the served one', () => {
        let {cache} = setup()
        cache.store(ALICE, TOKEN, 5n, 130, hash(130))
        expect(cache.candidates(ALICE, [{token: TOKEN, lastSeenBlock: 100}], 120).size).toBe(0)
        // ...but keeps it for newer snapshots.
        expect(cache.candidates(ALICE, [{token: TOKEN, lastSeenBlock: 100}], 130).size).toBe(1)
    })

    it('skips always-refresh tokens and expires old entries', () => {
        let {cache, now} = setup()
        cache.store(ALICE, WETH, 5n, 100, hash(100))
        cache.store(ALICE, TOKEN, 5n, 100, hash(100))
        let rows = [{token: WETH, lastSeenBlock: 1}, {token: TOKEN, lastSeenBlock: 1}]
        expect([...cache.candidates(ALICE, rows, 100).keys()]).toEqual([TOKEN])
        now.t = 1000
        expect(cache.candidates(ALICE, rows, 100).size).toBe(0)
    })

    it('drops entries whose block is no longer canonical', () => {
        let {cache} = setup()
        cache.store(ALICE, TOKEN, 5n, 100, hash(100))
        let candidates = cache.candidates(ALICE, [{token: TOKEN, lastSeenBlock: 1}], 110)
        expect(cache.confirm(ALICE, candidates, new Map([[100, hash(100)]])).size).toBe(1)
        expect(cache.confirm(ALICE, candidates, new Map([[100, hash(999)]])).size).toBe(0)
        expect(cache.candidates(ALICE, [{token: TOKEN, lastSeenBlock: 1}], 110).size).toBe(0)
    })

    it('does not overwrite a newer read with an older one', () => {
        let {cache} = setup()
        cache.store(ALICE, TOKEN, 6n, 110, hash(110))
        cache.store(ALICE, TOKEN, 5n, 100, hash(100))
        expect(cache.candidates(ALICE, [{token: TOKEN, lastSeenBlock: 1}], 120).get(TOKEN)?.block).toBe(110)
    })
})

describe('BalanceService', () => {
    it('reads misses through the batcher, caches them and serves them at later blocks', async () => {
        let node = new FakeMulticallNode(() => 9n)
        let config = {...balanceConfigFromEnv({}), batchWindowMs: 1}
        let service = new BalanceService(node, config)
        let rows = [{token: TOKEN, lastSeenBlock: 90}]
        let canonical = async (numbers: number[]) => new Map(numbers.map(n => [n, hash(n)]))

        let first = await service.fromCache(ALICE, rows, {number: 100, hash: hash(100)}, canonical)
        expect(first.size).toBe(0)
        let fetched = await service.fetch(ALICE, [TOKEN], {number: 100, hash: hash(100)})
        expect(fetched.get(TOKEN)).toEqual({balance: 9n})

        let lookedUp: number[][] = []
        let hits = await service.fromCache(ALICE, rows, {number: 105, hash: hash(105)}, async numbers => {
            lookedUp.push(numbers)
            return canonical(numbers)
        })
        expect(hits.get(TOKEN)).toMatchObject({balance: 9n, block: 100})
        expect(lookedUp).toEqual([[100]])
        expect(node.calls).toHaveLength(1)
        expect(service.snapshotStats()).toMatchObject({cacheHits: 1, cacheMisses: 1, rpcCalls: 1, pairs: 1})
    })

    it('parses env with defaults and validation', () => {
        let config = balanceConfigFromEnv({})
        expect(config).toMatchObject({batchSize: 500, batchWindowMs: 20, concurrency: 8, maxQueuedBatches: 64, deadlineMs: 8000, cacheSize: 200_000})
        expect(config.alwaysRefresh.has(WETH)).toBe(true)
        expect(balanceConfigFromEnv({BALANCE_ALWAYS_REFRESH_TOKENS: ' 0xABC ,'}).alwaysRefresh).toEqual(new Set(['0xabc']))
        expect(() => balanceConfigFromEnv({BALANCE_BATCH_SIZE: '0'})).toThrow(/BALANCE_BATCH_SIZE/)
    })
})
