import type {TokenStandard} from '../model'

export type Direction = 'in' | 'out'

export interface Interaction {
    account: string // lowercase 0x address
    token: string // lowercase contract address
    standard: TokenStandard
    direction: Direction
    block: number
    // reserved for NFTs: tokenId?: bigint; amount?: bigint
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
