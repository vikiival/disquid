import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, IntColumn as IntColumn_, Index as Index_, StringColumn as StringColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class Block {
    constructor(props?: Partial<Block>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_("idx_block_number_02904b31", {unique: true})
    @IntColumn_({nullable: false})
    number!: number

    @StringColumn_({nullable: false})
    hash!: string

    @DateTimeColumn_({nullable: false})
    timestamp!: Date
}
