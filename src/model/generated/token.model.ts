import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, IntColumn as IntColumn_, StringColumn as StringColumn_, Index as Index_, OneToMany as OneToMany_, Relation as Relation_} from "@subsquid/typeorm-store"
import {TokenMetadataStatus} from "./_tokenMetadataStatus"
import {AccountToken} from "./accountToken.model"

@Entity_()
export class Token {
    constructor(props?: Partial<Token>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @IntColumn_({nullable: false})
    firstSeenBlock!: number

    @StringColumn_({nullable: true})
    name!: string | undefined | null

    @StringColumn_({nullable: true})
    symbol!: string | undefined | null

    @IntColumn_({nullable: true})
    decimals!: number | undefined | null

    @Index_("idx_token_metadata_status_eb1abad3")
    @Column_("varchar", {length: 7, nullable: false})
    metadataStatus!: TokenMetadataStatus

    @OneToMany_(() => AccountToken, e => e.token)
    accounts!: Relation_<AccountToken[]>
}
