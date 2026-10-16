import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, Index as Index_, StringColumn as StringColumn_, ManyToOne as ManyToOne_, Relation as Relation_, IntColumn as IntColumn_} from "@subsquid/typeorm-store"
import {Token} from "./token.model"
import {TokenStandard} from "./_tokenStandard"

@Index_("idx_account_token_account_standard_token_2886f3bb", ["account", "standard", "token"], {unique: true})
@Entity_()
export class AccountToken {
    constructor(props?: Partial<AccountToken>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    account!: string

    @Index_("idx_account_token_token_9341bbb4")
    @ManyToOne_(() => Token, {nullable: true})
    token!: Relation_<Token>

    @Column_("varchar", {length: 7, nullable: false})
    standard!: TokenStandard

    @IntColumn_({nullable: false})
    firstSeenBlock!: number

    @IntColumn_({nullable: false})
    lastSeenBlock!: number

    @IntColumn_({nullable: false})
    sentCount!: number

    @IntColumn_({nullable: false})
    receivedCount!: number
}
