import {describe, expect, it, vi} from 'vitest'

import {TokenStandard} from '../../src/model'
import {accountTokenId, decodeLog, enabledDecoders, erc20, standardCode, topic0Union, TRANSFER_TOPIC} from '../../src/standards'
import type {StandardDecoder} from '../../src/standards'


const word = (addr: string) => '0x' + addr.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'
const TOKEN = '0xC0C0C0c0C0c0C0C0c0c0C0c0C0c0C0c0c0C0C0c0'
const ZERO = '0x' + '0'.repeat(40)
const DATA = '0x' + '0'.repeat(63) + '1'

const log = (topics: string[], data = DATA, address = TOKEN) => ({address, topics, data})

describe('erc20 decoder', () => {
    it('emits out for from and in for to, lowercased', () => {
        const result = decodeLog(log([TRANSFER_TOPIC, word(A), word(B)]), 7)
        expect(result).toEqual([
            {account: A.toLowerCase(), token: TOKEN.toLowerCase(), standard: TokenStandard.ERC20, direction: 'out', block: 7},
            {account: B.toLowerCase(), token: TOKEN.toLowerCase(), standard: TokenStandard.ERC20, direction: 'in', block: 7},
        ])
    })

    it('accepts an uppercase topic0', () => {
        const topic0 = '0x' + TRANSFER_TOPIC.slice(2).toUpperCase()
        expect(decodeLog(log([topic0, word(A), word(B)]), 1)).toHaveLength(2)
    })

    it('skips the zero address as an account on mint and burn', () => {
        const mint = decodeLog(log([TRANSFER_TOPIC, word(ZERO), word(B)]), 1)
        expect(mint.map(i => [i.account, i.direction])).toEqual([[B.toLowerCase(), 'in']])
        const burn = decodeLog(log([TRANSFER_TOPIC, word(A), word(ZERO)]), 1)
        expect(burn.map(i => [i.account, i.direction])).toEqual([[A.toLowerCase(), 'out']])
        expect(decodeLog(log([TRANSFER_TOPIC, word(ZERO), word(ZERO)]), 1)).toEqual([])
    })

    it('rejects ERC-721 shaped Transfer (4 topics, empty data)', () => {
        const tokenId = '0x' + '0'.repeat(63) + '5'
        expect(erc20.decode(log([TRANSFER_TOPIC, word(A), word(B), tokenId], '0x'), 1)).toEqual([])
        expect(erc20.decode(log([TRANSFER_TOPIC, word(A), word(B), tokenId]), 1)).toEqual([])
    })

    it('rejects bad data lengths', () => {
        expect(decodeLog(log([TRANSFER_TOPIC, word(A), word(B)], '0x'), 1)).toEqual([])
        expect(decodeLog(log([TRANSFER_TOPIC, word(A), word(B)], '0x' + '00'.repeat(31)), 1)).toEqual([])
        expect(decodeLog(log([TRANSFER_TOPIC, word(A), word(B)], '0x' + '00'.repeat(33)), 1)).toEqual([])
        expect(decodeLog(log([TRANSFER_TOPIC, word(A), word(B)], '0x' + 'zz'.repeat(32)), 1)).toEqual([])
    })

    it('rejects topics that are not zero-padded addresses', () => {
        const dirty = '0x' + '00'.repeat(11) + '01' + 'aa'.repeat(20)
        expect(decodeLog(log([TRANSFER_TOPIC, dirty, word(B)]), 1)).toEqual([])
        expect(decodeLog(log([TRANSFER_TOPIC, word(A), dirty]), 1)).toEqual([])
        expect(decodeLog(log([TRANSFER_TOPIC, '0x' + 'aa'.repeat(20), word(B)]), 1)).toEqual([])
    })

    it('rejects a wrong topic0 and logs without topics', () => {
        const approval = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
        expect(decodeLog(log([approval, word(A), word(B)]), 1)).toEqual([])
        expect(decodeLog(log([]), 1)).toEqual([])
    })
})

describe('registry', () => {
    it('exposes ERC-20 and ERC-721, sharing one topic0', () => {
        expect(enabledDecoders().map(d => d.standard)).toEqual([TokenStandard.ERC20, TokenStandard.ERC721])
        expect(topic0Union()).toEqual([TRANSFER_TOPIC])
    })

    it('dispatches to the decoder owning each Transfer layout', () => {
        const erc20Log = log([TRANSFER_TOPIC, word(A), word(B)])
        const nftLog = log([TRANSFER_TOPIC, word(A), word(B), word('0x5')], '0x')
        expect(decodeLog(erc20Log, 1).map(i => i.standard)).toEqual([TokenStandard.ERC20, TokenStandard.ERC20])
        expect(decodeLog(nftLog, 1).map(i => i.standard)).toEqual([TokenStandard.ERC721, TokenStandard.ERC721])
    })

    it('builds ids with the standard code', () => {
        expect(standardCode(TokenStandard.ERC20)).toBe(20)
        expect(standardCode(TokenStandard.ERC721)).toBe(721)
        expect(standardCode(TokenStandard.ERC1155)).toBe(1155)
        expect(accountTokenId('0xa', '0xb', TokenStandard.ERC1155)).toBe('0xa:0xb:1155')
    })
})
