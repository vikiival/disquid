// Closed-loop load test for i-see-u GET /v1/ethereum/accounts/{addr}/erc20, adapted from disquid/scripts/loadtest.mjs.
// usage: node loadtest-rest.mjs <accounts.txt> <concurrency> <seconds> [includeBalances] [finality]
import {readFileSync} from 'node:fs'

const [file, c = '20', d = '30', bal = 'false', fin = ''] = process.argv.slice(2)
const accounts = readFileSync(file, 'utf8').trim().split('\n')
const concurrency = Number(c)
const until = Date.now() + Number(d) * 1000
const qs = (bal === 'true' ? '?balances=true' : '?') + (fin ? `&finality=${fin}` : '')

const lat = []
let errors = 0, tokens = 0, bytes = 0
const statuses = {}
const sample = {}

async function worker() {
    while (Date.now() < until) {
        const account = accounts[Math.floor(Math.random() * accounts.length)]
        const t0 = performance.now()
        try {
            const res = await fetch(`http://localhost:3000/v1/ethereum/accounts/${account}/erc20${qs}`)
            const text = await res.text()
            statuses[res.status] = (statuses[res.status] || 0) + 1
            if (res.status !== 200) { errors++; sample[res.status] ??= text.slice(0, 200) }
            else {
                bytes += text.length
                const body = JSON.parse(text)
                tokens += (body.tokens ?? body.items ?? []).length
            }
        } catch (e) {
            errors++
            statuses.exception = (statuses.exception || 0) + 1
            sample.exception ??= String(e).slice(0, 200)
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
    concurrency, balances: bal === 'true', seconds: secs.toFixed(1), requests: lat.length, rps: (lat.length / secs).toFixed(0),
    p50: p(0.5), p95: p(0.95), p99: p(0.99), max: lat.at(-1).toFixed(1), errors, statuses, sample,
    avgTokens: (tokens / Math.max(1, lat.length - errors)).toFixed(1),
    avgKB: (bytes / Math.max(1, lat.length - errors) / 1024).toFixed(1),
}))
