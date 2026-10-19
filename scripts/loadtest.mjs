// Closed-loop load test for tokenDiscovery: C workers, each sends the next request as soon as the
// previous one returns, for D seconds, over random real accounts.
// usage: node scripts/loadtest.mjs <accounts.txt> <concurrency> <seconds> [includeBalances]
import {readFileSync} from 'node:fs'

const [file, c = '20', d = '30', bal = 'false'] = process.argv.slice(2)
const accounts = readFileSync(file, 'utf8').trim().split('\n')
const concurrency = Number(c)
const until = Date.now() + Number(d) * 1000
const query = `query($a: String!, $b: Boolean!) { tokenDiscovery(account: $a, includeBalances: $b, first: 100) {
  blockHeight tokens { token symbol decimals lastSeenBlock balance balanceError } } }`

const lat = []
let errors = 0, tokens = 0

async function worker() {
    while (Date.now() < until) {
        const account = accounts[Math.floor(Math.random() * accounts.length)]
        const t0 = performance.now()
        try {
            const res = await fetch('http://localhost:4350/graphql', {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({query, variables: {a: account, b: bal === 'true'}}),
            })
            const body = await res.json()
            if (!res.ok || body.errors) errors++
            else tokens += body.data.tokenDiscovery.tokens.length
        } catch {
            errors++
        }
        lat.push(performance.now() - t0)
    }
}

const start = Date.now()
await Promise.all(Array.from({length: concurrency}, worker))
const secs = (Date.now() - start) / 1000
lat.sort((a, b) => a - b)
const p = q => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1)
console.log(JSON.stringify({
    concurrency, seconds: secs.toFixed(1), requests: lat.length, rps: (lat.length / secs).toFixed(0),
    p50: p(0.5), p95: p(0.95), p99: p(0.99), max: lat.at(-1).toFixed(1), errors,
    avgTokens: (tokens / Math.max(1, lat.length - errors)).toFixed(1),
}))
