import {describe, expect, it} from 'vitest'

import {TokenStandard} from '../../src/model'
import {decodeLog, erc721, TRANSFER_TOPIC} from '../../src/standards'

const word = (addr: string) => '0x' + addr.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const B = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'
const TOKEN = '0xD1D1D1d1D1d1D1D1d1d1D1d1D1d1d1D1D1d1D1d1'
const ZERO = '0x' + '0'.repeat(40)

const nftLog = (topics: string[], data = '0x', address = TOKEN) => ({address, topics, data})
const id = 5n
const MAX_UINT = BigInt('0x' + 'f'.repeat(64))

describe('erc721 decoder', () => {
    it('emits out for from and in for to, with tokenId, lowercased', () => {
        const result = decodeLog(nftLog([TRANSFER_TOPIC, word(A), word(B), word(`0x${id.toString(16)}`)]), 7)
        expect(result).toEqual([
            {account: A.toLowerCase(), token: TOKEN.toLowerCase(), standard: TokenStandard.ERC721, direction: 'out', block: 7, tokenId: id},
            {account: B.toLowerCase(), token: TOKEN.toLowerCase(), standard: TokenStandard.ERC721, direction: 'in', block: 7, tokenId: id},
        ])
    })

    it('decodes huge tokenIds', () => {
        const result = decodeLog(nftLog([TRANSFER_TOPIC, word(A), word(B), '0x' + MAX_UINT.toString(16)]), 3)
        expect(result.every(i => i.tokenId === MAX_UINT)).toBe(true)
    })

    it('skips the zero address as an account on mint and burn', () => {
        const mint = decodeLog(nftLog([TRANSFER_TOPIC, word(ZERO), word(B), word('0x5')]), 1)
        expect(mint.map(i => i.account)).toEqual([B.toLowerCase()])
        expect(mint.every(i => i.direction === 'in')).toBe(true)
        const burn = decodeLog(nftLog([TRANSFER_TOPIC, word(A), word(ZERO), word('0x5')]), 1)
        expect(burn.map(i => i.account)).toEqual([A.toLowerCase()])
        expect(burn.every(i => i.direction === 'out')).toBe(true)
        expect(decodeLog(nftLog([TRANSFER_TOPIC, word(ZERO), word(ZERO), word('0x5')]), 1)).toEqual([])
    })

    it('rejects ERC-20 shaped Transfer (3 topics, one data word)', () => {
        expect(erc721.decode({address: TOKEN, topics: [TRANSFER_TOPIC, word(A), word(B)], data: '0x' + '0'.repeat(63) + '1'}, 1)).toEqual([])
    })

    it('rejects malformed data (only exactly 0x is accepted)', () => {
        const topics = [TRANSFER_TOPIC, word(A), word(B), word('0x5')]
        expect(erc721.decode({address: TOKEN, topics, data: ''}, 1)).toEqual([])
        expect(erc721.decode({address: TOKEN, topics, data: '0x0001'}, 1)).toEqual([])
        expect(erc721.decode({address: TOKEN, topics, data: '0x' + '00'.repeat(32)}, 1)).toEqual([])
    })

    it('rejects topics that are not zero-padded addresses', () => {
        const dirty = '0x' + '00'.repeat(11) + '01' + 'aa'.repeat(20)
        expect(decodeLog(nftLog([TRANSFER_TOPIC, dirty, word(B), word('0x5')]), 1)).toEqual([])
        expect(decodeLog(nftLog([TRANSFER_TOPIC, word(A), dirty, word('0x5')]), 1)).toEqual([])
        expect(decodeLog(nftLog([TRANSFER_TOPIC, '0x' + 'aa'.repeat(20), word(B), word('0x5')]), 1)).toEqual([])
    })

    it('rejects a malformed tokenId word', () => {
        expect(decodeLog(nftLog([TRANSFER_TOPIC, word(A), word(B), '0x' + 'zz'.repeat(32)]), 1)).toEqual([])
    })

    it('rejects a wrong topic0 and logs without topics', () => {
        expect(decodeLog(nftLog(['0x' + '9'.repeat(64), word(A), word(B), word('0x5')]), 1)).toEqual([])
        expect(decodeLog(nftLog([]), 1)).toEqual([])
    })
})
