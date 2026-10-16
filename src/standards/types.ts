import type {TokenStandard} from '../model'

export type Direction = 'in' | 'out'

export interface Interaction {
    account: string // lowercase 0x address
    token: string // lowercase contract address
    standard: TokenStandard
    direction: Direction
    block: number
    // ERC-721 only: the token id moved by the Transfer.
    tokenId?: bigint
}

export const WORD_RE = /^0x[0-9a-fA-F]{64}$/

export function topicAddress(topic: string | undefined): string | undefined {
    // An indexed address is a 32-byte word with 12 zero bytes in front. Anything else is not an
    // address (some non-standard contracts reuse the Transfer topic with other layouts).
    if (topic == null || !WORD_RE.test(topic)) return undefined
    if (!topic.startsWith('0x' + '0'.repeat(24))) return undefined
    return '0x' + topic.slice(26).toLowerCase()
}

export interface RawLog {
    address: string
    topics: string[]
    data: string
}

export interface StandardDecoder {
    standard: TokenStandard
    topic0: string[] // pushed down to eth_getLogs and used in addLog
    decode(log: RawLog, block: number): Interaction[]
}
