import {describe, expect, it} from 'vitest'

import {deriveLogsFilter, needsTransactions} from '../../src/source'

const T = '0xDDF252AD1BE2C89B69C2B068FC378DAA952BA7F163C4A11628F55A4DF523B3EF'
const U = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const A = '0x' + 'aa'.repeat(20)

describe('logs filter derivation', () => {
    it('pushes the lower-cased topic0 union', () => {
        expect(deriveLogsFilter([{logs: [{topic0: [T]}]}, {logs: [{topic0: [U, T.toLowerCase()]}]}])).toEqual({
            topic0: [U, T.toLowerCase()],
        })
    })

    it('pushes addresses only when every log request has them', () => {
        expect(deriveLogsFilter([{logs: [{topic0: [T], address: [A]}]}])).toEqual({topic0: [T.toLowerCase()], address: [A]})
        expect(deriveLogsFilter([{logs: [{topic0: [T], address: [A]}, {topic0: [U]}]}])).toEqual({topic0: [U, T.toLowerCase()].sort()})
    })

    it('drops the topic filter when one request matches any topic0', () => {
        expect(deriveLogsFilter([{logs: [{topic0: [T]}, {address: [A]}]}])).toEqual({})
        expect(deriveLogsFilter([{logs: [{topic0: []}]}])).toEqual({})
    })

    it('drops the filter when whole-transaction logs are needed', () => {
        expect(deriveLogsFilter([{logs: [{topic0: [T], transactionLogs: true}]}])).toEqual({})
        expect(deriveLogsFilter([{logs: [{topic0: [T]}], transactions: [{to: [A], logs: true}]}])).toEqual({})
        expect(deriveLogsFilter([{logs: [{topic0: [T]}], traces: [{transactionLogs: true}]}])).toEqual({})
    })
})

describe('header-only rule', () => {
    it('needs no transactions for logs with log fields only', () => {
        expect(needsTransactions([{logs: [{topic0: [T]}], includeAllBlocks: true}], {log: {topics: true}})).toBe(false)
    })

    it('needs transactions when any request or field selection refers to them', () => {
        expect(needsTransactions([{logs: [{topic0: [T], transaction: true}]}], {})).toBe(true)
        expect(needsTransactions([{logs: [{topic0: [T]}]}], {transaction: {hash: true}})).toBe(true)
        expect(needsTransactions([{transactions: [{to: [A]}]}], {})).toBe(true)
        expect(needsTransactions([{logs: [{topic0: [T], transactionTraces: true}]}], {})).toBe(true)
        expect(needsTransactions([{stateDiffs: [{address: [A]}]}], {})).toBe(true)
    })
})
