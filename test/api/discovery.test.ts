import {readdirSync, readFileSync} from 'fs'
import {createRequire} from 'module'
import path from 'path'
import {parse} from 'dotenv'
import {DataSource} from 'typeorm'
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {TokenStandard} from '../../src/model'
import {balanceConfigFromEnv} from '../../src/server-extension/balances/config'
import {BalanceService} from '../../src/server-extension/balances/service'
import {discoverTokens, type SnapshotSource, type SqlRunner, TokenDiscoveryError} from '../../src/server-extension/discovery'
import {TokenDiscoveryResolver} from '../../src/server-extension/resolvers'
import {addr, FakeMulticallNode, hash} from './fakes'

const ROOT = path.resolve(__dirname, '../..')
const ALICE = addr(0xa11ce)
const BOB = addr(0xb0b)
const SCHEMA = `api_test_${process.pid}_${Date.now()}`

// Only DB settings are taken from .env: the RPC endpoint must never reach these tests.
const dotenv = (() => {
    try {
        return parse(readFileSync(path.join(ROOT, '.env')))
    } catch {
        return {} as Record<string, string>
    }
})()
const dbEnv = (name: string, def: string) => process.env[name] ?? dotenv[name] ?? def

let db: DataSource
let dbAvailable = false

beforeAll(async () => {
    db = new DataSource({
        type: 'postgres',
        host: dbEnv('DB_HOST', 'localhost'),
        port: Number(dbEnv('DB_PORT', '5432')),
        database: dbEnv('DB_NAME', 'squid'),
        username: dbEnv('DB_USER', 'postgres'),
        password: dbEnv('DB_PASS', 'postgres'),
        extra: {options: `-c search_path=${SCHEMA}`, max: 4},
    })
    try {
        await db.initialize()
    } catch (err) {
        console.warn(`skipping DB tests: ${err}`)
        return
    }
    dbAvailable = true
    await db.query(`CREATE SCHEMA ${SCHEMA}`)
    // The real migrations, applied inside the throwaway schema via search_path.
    let dir = path.join(ROOT, 'db/migrations')
    let req = createRequire(__filename)
    for (let file of readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
        let Migration = req(path.join(dir, file))
        await new Migration().up(db)
    }
})

afterAll(async () => {
    if (dbAvailable) await db.query(`DROP SCHEMA ${SCHEMA} CASCADE`)
    if (db?.isInitialized) await db.destroy()
})

async function reset() {
    await db.query('TRUNCATE account_token, token, block')
}

async function addBlock(n: number, blockHash = hash(n)) {
    await db.query('INSERT INTO block (id, number, hash, timestamp) VALUES ($1, $2, $3, $4)', [
        String(n).padStart(10, '0'), n, blockHash, new Date(1_700_000_000_000 + n * 12_000),
    ])
}

async function addToken(token: string, symbol: string | null = null, decimals: number | null = null) {
    await db.query('INSERT INTO token (id, first_seen_block, symbol, decimals) VALUES ($1, 1, $2, $3) ON CONFLICT DO NOTHING', [token, symbol, decimals])
}

async function addRow(account: string, token: string, lastSeenBlock: number, standard = TokenStandard.ERC20) {
    await addToken(token)
    let code = {ERC20: 20, ERC721: 721, ERC1155: 1155}[standard]
    await db.query(
        `INSERT INTO account_token (id, account, token_id, standard, first_seen_block, last_seen_block, sent_count, received_count)
         VALUES ($1, $2, $3, $4, 1, $5, 1, 2)
         ON CONFLICT (id) DO UPDATE SET last_seen_block = EXCLUDED.last_seen_block`,
        [`${account}:${token}:${code}`, account, token, standard, lastSeenBlock],
    )
}

function balanceService(node: FakeMulticallNode) {
    return new BalanceService(node, {...balanceConfigFromEnv({}), batchWindowMs: 1})
}

describe.runIf(process.env.SKIP_DB_TESTS == null)('tokenDiscovery against Postgres', () => {
    beforeEach(async ({skip}) => {
        if (!dbAvailable) skip()
        await reset()
    })

    it('fails clearly while the index is empty', async () => {
        let err = await discoverTokens(db, {account: ALICE}).catch(e => e)
        expect(err).toBeInstanceOf(TokenDiscoveryError)
        expect(err.extensions.code).toBe('INDEX_NOT_READY')
    })

    it('validates and normalises arguments', async () => {
        await addBlock(10)
        await addRow(ALICE, addr(1), 5)
        for (let args of [{account: '0x123'}, {account: ALICE, first: 0}, {account: ALICE, first: 501}, {account: ALICE, after: 'abc'}]) {
            let err = await discoverTokens(db, args).catch(e => e)
            expect(err.extensions?.code, JSON.stringify(args)).toBe('BAD_USER_INPUT')
        }
        let mixedCase = '0x' + ALICE.slice(2).toUpperCase()
        let res = await discoverTokens(db, {account: mixedCase})
        expect(res.account).toBe(ALICE)
        expect(res.tokens.map(t => t.token)).toEqual([addr(1)])
    })

    it('pages by token address with a cursor and reports the served block', async () => {
        for (let n = 1; n <= 3; n++) await addBlock(n)
        for (let t of [5, 3, 1, 4, 2]) await addRow(ALICE, addr(t), 2)
        await addRow(BOB, addr(9), 2)
        await addRow(ALICE, addr(7), 2, TokenStandard.ERC721)
        await db.query(`UPDATE token SET name = 'One', symbol = 'ONE', decimals = 6 WHERE id = $1`, [addr(1)])

        let page1 = await discoverTokens(db, {account: ALICE, first: 2})
        expect(page1).toMatchObject({account: ALICE, standard: 'ERC20', blockHeight: 3, blockHash: hash(3), nextCursor: addr(2), balancesComplete: null})
        expect(page1.blockTimestamp).toEqual(new Date(1_700_000_000_000 + 3 * 12_000))
        expect(page1.tokens).toEqual([
            {token: addr(1), name: 'One', symbol: 'ONE', decimals: 6, firstSeenBlock: 1, lastSeenBlock: 2, sentCount: 1, receivedCount: 2, balance: null, balanceFormatted: null, balanceBlock: null, balanceError: null},
            expect.objectContaining({token: addr(2), symbol: null, decimals: null}),
        ])
        let withBalances = await discoverTokens(db, {account: ALICE, first: 2, includeBalances: true}, balanceService(new FakeMulticallNode(() => 1_500_000n)))
        expect(withBalances.tokens.map(t => [t.balance, t.balanceFormatted])).toEqual([[1_500_000n, '1.5'], [1_500_000n, null]])
        let page2 = await discoverTokens(db, {account: ALICE, first: 2, after: page1.nextCursor})
        expect(page2.tokens.map(t => t.token)).toEqual([addr(3), addr(4)])
        let page3 = await discoverTokens(db, {account: ALICE, first: 2, after: page2.nextCursor!.toUpperCase().replace('0X', '0x')})
        expect(page3.tokens.map(t => t.token)).toEqual([addr(5)])
        expect(page3.nextCursor).toBeNull()

        let nft = await discoverTokens(db, {account: ALICE, standard: TokenStandard.ERC721})
        expect(nft.tokens.map(t => t.token)).toEqual([addr(7)])
    })

    it('reads head and rows from one snapshot even if the processor commits in between', async () => {
        await addBlock(1)
        await addRow(ALICE, addr(1), 1)
        let committed = false
        // Commit block 2 with a new token right after the transaction's first statement.
        let racing: SnapshotSource = {
            transaction: (iso, run) => db.transaction(iso, async em => {
                let wrapped: SqlRunner = {
                    async query(sql, params) {
                        let rows = await em.query(sql, params as any[])
                        if (!committed) {
                            committed = true
                            await addBlock(2)
                            await addRow(ALICE, addr(2), 2)
                        }
                        return rows
                    },
                }
                return run(wrapped)
            }),
        }
        let res = await discoverTokens(racing, {account: ALICE})
        expect(committed).toBe(true)
        expect(res.blockHeight).toBe(1)
        expect(res.tokens.map(t => t.token)).toEqual([addr(1)])

        let after = await discoverTokens(db, {account: ALICE})
        expect(after.blockHeight).toBe(2)
        expect(after.tokens).toHaveLength(2)
    })

    it('serves cached balances only while unchanged and canonical', async () => {
        let node = new FakeMulticallNode((token, _account, blockHash) => BigInt(parseInt(token, 16)) * 100n + BigInt(parseInt(blockHash, 16)))
        let service = balanceService(node)
        await addBlock(10)
        await addRow(ALICE, addr(1), 10)
        await addRow(ALICE, addr(2), 10)

        let r10 = await discoverTokens(db, {account: ALICE, includeBalances: true}, service)
        expect(r10.balancesComplete).toBe(true)
        expect(r10.tokens.map(t => [t.balance, t.balanceBlock])).toEqual([[110n, 10], [210n, 10]])
        expect(node.calls).toHaveLength(1)

        // Block 11: token 2 moved, token 1 did not -> token 1 from cache (read at 10), token 2 re-read.
        await addBlock(11)
        await addRow(ALICE, addr(2), 11)
        let r11 = await discoverTokens(db, {account: ALICE, includeBalances: true}, service)
        expect(r11.blockHeight).toBe(11)
        expect(r11.tokens.map(t => [t.balance, t.balanceBlock])).toEqual([[110n, 10], [211n, 11]])
        expect(node.calls).toHaveLength(2)
        expect(node.calls[1]).toMatchObject({blockHash: hash(11), pairs: [{token: addr(2), account: ALICE}]})

        // Reorg replaces block 10: the read at the old hash is no longer trusted.
        await db.query('UPDATE block SET hash = $1 WHERE number = 10', [hash(0xdead)])
        await addBlock(12)
        let r12 = await discoverTokens(db, {account: ALICE, includeBalances: true}, service)
        expect(r12.tokens.map(t => [t.balance, t.balanceBlock])).toEqual([[112n, 12], [211n, 11]])
        expect(node.calls).toHaveLength(3)
        expect(node.calls[2].pairs.map(p => p.token)).toEqual([addr(1)])
    })

    it('returns discovery with per-token errors when balances fail', async () => {
        let node = new FakeMulticallNode(token => (token === addr(2) ? 'revert' : 1n))
        let service = balanceService(node)
        await addBlock(10)
        await addRow(ALICE, addr(1), 10)
        await addRow(ALICE, addr(2), 10)
        let res = await discoverTokens(db, {account: ALICE, includeBalances: true}, service)
        expect(res.balancesComplete).toBe(false)
        expect(res.tokens.map(t => [t.balance, t.balanceError])).toEqual([[1n, null], [null, 'CALL_FAILED']])

        node.fail = new Error('node down')
        await addBlock(11)
        await addRow(ALICE, addr(1), 11)
        let down = await discoverTokens(db, {account: ALICE, includeBalances: true}, service)
        expect(down.tokens.map(t => t.balanceError)).toEqual(['RPC_ERROR', 'RPC_ERROR'])
        expect(down.tokens).toHaveLength(2)
    })

    it('rejects includeBalances for ERC1155', async () => {
        await addBlock(1)
        let err = await discoverTokens(db, {account: ALICE, standard: TokenStandard.ERC1155, includeBalances: true}, balanceService(new FakeMulticallNode())).catch(e => e)
        expect(err.extensions.code).toBe('BAD_USER_INPUT')
    })

    it('merges into the generated schema and answers through GraphQL', async () => {
        // Build the schema exactly like @subsquid/graphql-server does (openreader + custom resolvers).
        let gs = createRequire(require.resolve('@subsquid/graphql-server/package.json'))
        let {loadCustomResolvers} = gs('./lib/resolvers')
        let {getSchemaBuilder} = gs('@subsquid/openreader/lib/dialect')
        let {loadModel, resolveGraphqlSchema} = gs('@subsquid/openreader/lib/tools')
        let {mergeSchemas} = gs('@graphql-tools/schema')
        let {graphql, printType} = gs('graphql')

        let generated = (await getSchemaBuilder({model: loadModel(resolveGraphqlSchema(ROOT))})).build()
        let custom = await loadCustomResolvers(TokenDiscoveryResolver)
        let schema = mergeSchemas({schemas: [generated, custom]})
        expect(printType(schema.getType('TokenStandard'))).toBe('enum TokenStandard {\n  ERC20\n  ERC721\n  ERC1155\n}')
        expect(schema.getQueryType().getFields().accountTokens).toBeDefined()

        await addBlock(5)
        await addRow(ALICE, addr(1), 5)
        let res = await graphql({
            schema,
            source: `query($account: String!) {
                tokenDiscovery(account: $account, first: 10) {
                    account standard blockHeight blockHash blockTimestamp nextCursor balancesComplete
                    tokens { token name symbol decimals firstSeenBlock lastSeenBlock sentCount receivedCount balance balanceFormatted balanceBlock balanceError }
                }
            }`,
            variableValues: {account: ALICE.toUpperCase().replace('0X', '0x')},
            contextValue: {openreader: {connection: db, getEntityManager: () => Promise.reject(new Error('not used'))}},
        })
        expect(res.errors).toBeUndefined()
        expect(res.data.tokenDiscovery).toEqual({
            account: ALICE,
            standard: 'ERC20',
            blockHeight: 5,
            blockHash: hash(5),
            blockTimestamp: new Date(1_700_000_000_000 + 5 * 12_000).toISOString(),
            nextCursor: null,
            balancesComplete: null,
            tokens: [{token: addr(1), name: null, symbol: null, decimals: null, firstSeenBlock: 1, lastSeenBlock: 5, sentCount: 1, receivedCount: 2, balance: null, balanceFormatted: null, balanceBlock: null, balanceError: null}],
        })

        let bad = await graphql({
            schema,
            source: '{ tokenDiscovery(account: "nope") { blockHeight } }',
            contextValue: {openreader: {connection: db}},
        })
        expect(bad.errors[0].extensions.code).toBe('BAD_USER_INPUT')
    })
})
