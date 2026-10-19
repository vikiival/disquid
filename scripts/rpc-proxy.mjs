import http from 'node:http'
import { appendFileSync } from 'node:fs'
const upstream = process.env.UPSTREAM_RPC_URL
if (!upstream) throw new Error('UPSTREAM_RPC_URL missing')
const out = process.env.PROXY_OUT || new URL('./rpc-counts.jsonl', import.meta.url)
const totals = { httpRequests: 0, httpErrors: 0, rpcErrors: 0, perMethod: {} }
let window = {}
let winHttp = 0, winHttpErr = 0, winRpcErr = 0
const bump = (m) => { window[m] = (window[m] || 0) + 1; totals.perMethod[m] = (totals.perMethod[m] || 0) + 1 }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__counts') { res.end(JSON.stringify({ t: new Date().toISOString(), totals })); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks)
    totals.httpRequests++; winHttp++
    try {
      const j = JSON.parse(body.toString())
      for (const it of Array.isArray(j) ? j : [j]) bump(it?.method ?? 'unknown')
    } catch { bump('unparseable') }
    try {
      const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body })
      const buf = Buffer.from(await r.arrayBuffer())
      if (!r.ok) { totals.httpErrors++; winHttpErr++ }
      try {
        const rj = JSON.parse(buf.toString())
        for (const it of Array.isArray(rj) ? rj : [rj]) if (it && it.error) { totals.rpcErrors++; winRpcErr++ }
      } catch {}
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' })
      res.end(buf)
    } catch (e) {
      totals.httpErrors++; winHttpErr++
      res.writeHead(502); res.end(JSON.stringify({ error: 'upstream failure' }))
    }
  })
})
setInterval(() => {
  appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), perMethod: window, http: winHttp, httpErrors: winHttpErr, rpcErrors: winRpcErr, totals }) + '\n')
  window = {}; winHttp = 0; winHttpErr = 0; winRpcErr = 0
}, 60000)
const PORT = Number(process.env.PROXY_PORT || 8546)
server.listen(PORT, '127.0.0.1', () => console.log('proxy listening ' + PORT))
