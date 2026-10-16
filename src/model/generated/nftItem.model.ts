import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, Index as Index_, ManyToOne as ManyToOne_, Relation as Relation_, BigIntColumn as BigIntColumn_, StringColumn as StringColumn_, IntColumn as IntColumn_} from "@subsquid/typeorm-store"
import {Token} from "./token.model"

@Index_("idx_nft_item_contract_token_id_ea4e5347", ["contract", "tokenId"], {unique: true})
@Entity_()
export class NftItem {
    constructor(props?: Partial<NftItem>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @ManyToOne_(() => Token, {nullable: true})
    contract!: Relation_<Token>

    @BigIntColumn_({nullable: false})
    tokenId!: bigint

    @Index_("idx_nft_item_owner_aa552ac4")
    @StringColumn_({nullable: false})
    owner!: string

    @IntColumn_({nullable: false})
    lastTransferBlock!: number
}
