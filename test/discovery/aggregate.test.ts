import {describe, expect, it, vi} from 'vitest'

import {aggregate} from '../../src/discovery'
import {TokenStandard} from '../../src/model'
import {TRANSFER_TOPIC} from '../../src/standards'


const word = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0')
const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
const T1 = '0x' + '1'.repeat(40)
const T2 = '0x' + '2'.repeat(40)
const ZERO = '0x' + '0'.repeat(40)
const DATA = '0x' + '0'.repeat(63) + '1'

const transfer = (token: string, from: string, to: string) => ({
    address: token,
    topics: [TRANSFER_TOPIC, word(from), word(to)],
    data: DATA,
})
const block = (number: number, logs: ReturnType<typeof transfer>[] = []) => ({header: {number}, logs})

describe('aggregate', () => {
    it('folds logs across blocks into one row per account/token/standard', () => {
        const fold = aggregate([
            block(10, [transfer(T1, A, B)]),
            block(11),
            block(12, [transfer(T1, B, A), transfer(T2, A, B)]),
            block(13, [transfer(T1, A, B)]),
        ])
        expect([...fold.pending.keys()].sort()).toEqual(
            [`${A}:${T1}:20`, `${B}:${T1}:20`, `${A}:${T2}:20`, `${B}:${T2}:20`].sort(),
        )
        expect(fold.pending.get(`${A}:${T1}:20`)).toEqual({
            account: A,
            token: T1,
            standard: TokenStandard.ERC20,
            firstSeenBlock: 10,
            lastSeenBlock: 13,
            sentCount: 2,
            receivedCount: 1,
        })
        expect(fold.pending.get(`${B}:${T1}:20`)).toMatchObject({
            firstSeenBlock: 10,
            lastSeenBlock: 13,
            sentCount: 1,
            receivedCount: 2,
        })
        expect(fold.tokens).toEqual(
            new Map([
                [T1, 10],
                [T2, 12],
            ]),
        )
    })

    it('counts a self-transfer as one row with both counters incremented', () => {
        const fold = aggregate([block(5, [transfer(T1, A, A)])])
        expect(fold.pending.size).toBe(1)
        expect(fold.pending.get(`${A}:${T1}:20`)).toMatchObject({sentCount: 1, receivedCount: 1})
    })

    it('handles mint and burn without a zero-address account', () => {
        const fold = aggregate([block(5, [transfer(T1, ZERO, A), transfer(T2, B, ZERO)])])
        expect([...fold.pending.keys()].sort()).toEqual([`${A}:${T1}:20`, `${B}:${T2}:20`].sort())
        expect(fold.tokens.size).toBe(2)
    })

    it('ignores logs that no decoder owns and does not register their tokens', () => {
        const nft = {
            address: T1,
            topics: [TRANSFER_TOPIC, word(A), word(B), word('0x5')],
            data: '0x',
        }
        const fold = aggregate([{header: {number: 1}, logs: [nft]}])
        expect(fold.pending.size).toBe(0)
        expect(fold.tokens.size).toBe(0)
    })

    it('keeps the lowest block even if blocks arrive out of order', () => {
        const fold = aggregate([block(20, [transfer(T1, A, B)]), block(15, [transfer(T1, A, B)])])
        expect(fold.pending.get(`${A}:${T1}:20`)).toMatchObject({firstSeenBlock: 15, lastSeenBlock: 20})
        expect(fold.tokens.get(T1)).toBe(15)
    })
})
