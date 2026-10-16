import {TokenStandard} from '../model'
import {TRANSFER_TOPIC, ZERO_ADDRESS} from './erc20'
import {topicAddress, WORD_RE} from './types'
import type {Interaction, RawLog, StandardDecoder} from './types'

function topicUint256(topic: string | undefined): bigint | undefined {
    if (topic == null || !WORD_RE.test(topic)) return undefined
    return BigInt(topic)
}

export const erc721: StandardDecoder = {
    standard: TokenStandard.ERC721,
    topic0: [TRANSFER_TOPIC],
    decode(log: RawLog, block: number): Interaction[] {
        // ERC-20 shares this topic0 but carries the amount as data (3 topics, one data word).
        if (log.topics.length !== 4 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) return []
        if (log.data !== '0x') return []
        const from = topicAddress(log.topics[1])
        const to = topicAddress(log.topics[2])
        const tokenId = topicUint256(log.topics[3])
        if (from == null || to == null || tokenId == null) return []

        const token = log.address.toLowerCase()
        const result: Interaction[] = []
        // Mint/burn: the zero address is not an account, but the other side still interacted.
        if (from !== ZERO_ADDRESS) {
            result.push({account: from, token, standard: TokenStandard.ERC721, direction: 'out', block, tokenId})
        }
        if (to !== ZERO_ADDRESS) {
            result.push({account: to, token, standard: TokenStandard.ERC721, direction: 'in', block, tokenId})
        }
        return result
    },
}
