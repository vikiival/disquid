import {TokenStandard} from '../model'
import type {Interaction, RawLog, StandardDecoder} from './types'

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const ZERO_ADDRESS = '0x' + '0'.repeat(40)
const WORD_RE = /^0x[0-9a-fA-F]{64}$/
const DATA_RE = /^0x[0-9a-fA-F]{64}$/

// An indexed address is a 32-byte word with 12 zero bytes in front. Anything else is not an
// address (some non-standard contracts reuse the Transfer topic with other layouts).
function topicAddress(topic: string | undefined): string | undefined {
    if (topic == null || !WORD_RE.test(topic)) return undefined
    if (!topic.startsWith('0x' + '0'.repeat(24))) return undefined
    return '0x' + topic.slice(26).toLowerCase()
}

export const erc20: StandardDecoder = {
    standard: TokenStandard.ERC20,
    topic0: [TRANSFER_TOPIC],
    decode(log: RawLog, block: number): Interaction[] {
        // ERC-721 shares this topic0 but indexes tokenId (4 topics, empty data).
        if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) return []
        if (!DATA_RE.test(log.data)) return []
        const from = topicAddress(log.topics[1])
        const to = topicAddress(log.topics[2])
        if (from == null || to == null) return []

        const token = log.address.toLowerCase()
        const result: Interaction[] = []
        // Mint/burn: the zero address is not an account, but the other side still interacted.
        if (from !== ZERO_ADDRESS) {
            result.push({account: from, token, standard: TokenStandard.ERC20, direction: 'out', block})
        }
        if (to !== ZERO_ADDRESS) {
            result.push({account: to, token, standard: TokenStandard.ERC20, direction: 'in', block})
        }
        return result
    },
}
