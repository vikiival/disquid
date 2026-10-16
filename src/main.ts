import {createLogger} from '@subsquid/logger'
import {run} from '@subsquid/squid-sdk/processor'
import {TypeormDatabase} from '@subsquid/squid-sdk/store/typeorm'

import {aggregate, blockRetention, persistBatch} from './discovery'
import {createMetadataClient, MetadataLoader, metadataConfigFromEnv} from './metadata'
import {source} from './processor'

const log = createLogger('sqd:discovery')
const retention = blockRetention()
const metadataConfig = metadataConfigFromEnv()
const metadata = new MetadataLoader(createMetadataClient(metadataConfig), metadataConfig)

run(source, new TypeormDatabase({supportHotBlocks: true}), async (ctx) => {
    if (ctx.blocks.length === 0) return

    const fold = aggregate(ctx.blocks)
    const headers = ctx.blocks.map(b => b.header)
    const summary = await persistBatch(ctx.store, fold, headers, retention, metadata)

    log.debug({
        from: headers[0].number,
        to: headers[headers.length - 1].number,
        blocks: headers.length,
        isHead: ctx.isHead,
        accountTokens: summary.accountTokens,
        newTokens: summary.newTokens,
        metadataFetched: summary.metadataFetched,
        metadataPending: summary.metadataPending,
        prunedBlocks: summary.pruned,
    }, 'batch')
})
