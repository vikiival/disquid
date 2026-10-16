import {describe, expect, it} from 'vitest'
import {decodeDecimals, decodeLabel, fetchTokenMetadata, MAX_NAME, MetadataLoader} from '../../src/metadata'
import {addr} from '../api/fakes'
import {abiString, bytes32, decimalsWord, downError, FakeMetadataNode} from './fake-node'

describe('decoding', () => {
    it('reads a string, falling back to bytes32', () => {
        expect(decodeLabel(abiString('Tether USD'), 128)).toBe('Tether USD')
        expect(decodeLabel(bytes32('MKR'), 64)).toBe('MKR')
    })

    it('strips \\0 and control characters, trims, caps, and maps empty to null', () => {
        expect(decodeLabel(abiString('  A\u0000B\u0007C \n'), 64)).toBe('ABC')
        expect(decodeLabel(abiString('x'.repeat(500)), MAX_NAME)).toHaveLength(MAX_NAME)
        expect(decodeLabel(abiString('\u0000 '), 64)).toBeNull()
        expect(decodeLabel('0x', 64)).toBeNull()
        expect(decodeLabel('0x' + 'ff'.repeat(100), 64)).toBeNull() // garbage offset
    })

    it('accepts decimals up to 255 only', () => {
        expect(decodeDecimals(decimalsWord(18n))).toBe(18)
        expect(decodeDecimals(decimalsWord(255n))).toBe(255)
        expect(decodeDecimals(decimalsWord(256n))).toBeNull()
        expect(decodeDecimals(decimalsWord(2n ** 255n))).toBeNull()
        expect(decodeDecimals('0x12')).toBeNull()
    })
})

describe('fetchTokenMetadata', () => {
    const [USDT, MKR, EOA, BAD] = [addr(1), addr(2), addr(3), addr(4)]
    const node = () => new FakeMetadataNode({
        [USDT]: {name: abiString('Tether USD'), symbol: abiString('USDT'), decimals: decimalsWord(6n)},
        [MKR]: {name: bytes32('Maker'), symbol: bytes32('MKR'), decimals: decimalsWord(18n)},
        [BAD]: {name: 'revert', symbol: abiString('BAD'), decimals: decimalsWord(1000n)},
    })

    it('batches per chunk at latest and nulls the fields a token does not answer', async () => {
        let n = node()
        let res = await fetchTokenMetadata(n, [USDT, MKR, EOA, BAD], {batchSize: 3})
        expect(res.get(USDT)).toEqual({name: 'Tether USD', symbol: 'USDT', decimals: 6})
        expect(res.get(MKR)).toEqual({name: 'Maker', symbol: 'MKR', decimals: 18})
        expect(res.get(EOA)).toEqual({name: null, symbol: null, decimals: null})
        expect(res.get(BAD)).toEqual({name: null, symbol: 'BAD', decimals: null})
        expect(n.calls.map(c => c.tokens.length)).toEqual([3, 1])
        expect(n.calls.every(c => c.block === 'latest' && c.to === '0xca11bde05977b3631167028862be2a173976ca11')).toBe(true)
    })

    it('marks every token retry on an RPC-level failure and stops calling', async () => {
        let n = node()
        n.fail = downError()
        let res = await fetchTokenMetadata(n, [USDT, MKR, EOA], {batchSize: 1})
        expect([...res.values()]).toEqual(['retry', 'retry', 'retry'])
        expect(n.calls).toHaveLength(1)
        n = node()
        n.fail = new Error('socket hang up')
        expect((await fetchTokenMetadata(n, [USDT]))).toEqual(new Map([[USDT, 'retry']]))
    })

    it('bisects an execution error down to the hostile token, which gets null metadata', async () => {
        let n = node()
        n.poison.add(MKR)
        let res = await fetchTokenMetadata(n, [USDT, MKR, EOA, BAD])
        expect(res.get(MKR)).toEqual({name: null, symbol: null, decimals: null})
        expect(res.get(USDT)).toMatchObject({symbol: 'USDT'})
        expect(res.get(BAD)).toMatchObject({symbol: 'BAD'})
        expect(n.calls.length).toBeGreaterThan(1)
    })
})

describe('MetadataLoader backoff', () => {
    it('leaves the node alone for the backoff after a total failure, then tries again', async () => {
        let n = new FakeMetadataNode()
        n.fail = downError()
        let now = 1000
        let loader = new MetadataLoader(n, {batchSize: 50, sweepLimit: 200, retryBackoffMs: 60_000, multicallAddress: '0xca11bde05977b3631167028862be2a173976ca11'}, () => now)
        expect(loader.sweepLimit()).toBe(200)
        await loader.fetch([addr(1)])
        expect(loader.sweepLimit()).toBe(0)
        expect((await loader.fetch([addr(2)])).get(addr(2))).toBe('retry')
        expect(n.calls).toHaveLength(1)
        now += 60_000
        n.fail = undefined
        expect(loader.sweepLimit()).toBe(200)
        expect((await loader.fetch([addr(2)])).get(addr(2))).toEqual({name: null, symbol: null, decimals: null})
    })
})
