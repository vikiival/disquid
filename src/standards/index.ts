import {TokenStandard} from '../model'
import {erc20} from './erc20'
import {erc721} from './erc721'
import type {Interaction, RawLog, StandardDecoder} from './types'

export * from './types'
export {erc20, TRANSFER_TOPIC} from './erc20'
export {erc721} from './erc721'

export function enabledDecoders(): StandardDecoder[] {
    return [erc20, erc721]
}

export function topic0Union(decoders: StandardDecoder[] = enabledDecoders()): string[] {
    return [...new Set(decoders.flatMap(d => d.topic0.map(t => t.toLowerCase())))]
}

function byTopic0(decoders: StandardDecoder[]): Map<string, StandardDecoder[]> {
    const map = new Map<string, StandardDecoder[]>()
    for (const decoder of decoders) {
        for (const topic of decoder.topic0) {
            const key = topic.toLowerCase()
            const list = map.get(key)
            if (list == null) map.set(key, [decoder])
            else if (!list.includes(decoder)) list.push(decoder)
        }
    }
    return map
}

const defaultIndex = byTopic0(enabledDecoders())

// Several decoders may share a topic0 (ERC-20 and ERC-721 Transfer); each one rejects the shapes
// it does not own, so at most one of them returns interactions for a given log.
export function decodeLog(
    log: RawLog,
    block: number,
    decoders?: StandardDecoder[],
): Interaction[] {
    const index = decoders == null ? defaultIndex : byTopic0(decoders)
    const topic0 = log.topics[0]?.toLowerCase()
    if (topic0 == null) return []
    const candidates = index.get(topic0)
    if (candidates == null) return []
    const result: Interaction[] = []
    for (const decoder of candidates) result.push(...decoder.decode(log, block))
    return result
}

export function standardCode(standard: TokenStandard): 20 | 721 | 1155 {
    switch (standard) {
        case TokenStandard.ERC20:
            return 20
        case TokenStandard.ERC721:
            return 721
        case TokenStandard.ERC1155:
            return 1155
    }
}

export function accountTokenId(account: string, token: string, standard: TokenStandard): string {
    return `${account}:${token}:${standardCode(standard)}`
}
