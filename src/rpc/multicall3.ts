import * as p from '@subsquid/evm-codec'
import {func} from '@subsquid/evm-abi'

export const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'

// aggregate3((address target,bool allowFailure,bytes callData)[]) returns ((bool success,bytes returnData)[])
export const aggregate3 = func(
    '0x82ad56cb',
    {
        calls: p.array(
            p.struct({
                target: p.address,
                allowFailure: p.bool,
                callData: p.bytes,
            }),
        ),
    },
    p.array(p.struct({success: p.bool, returnData: p.bytes})),
)
