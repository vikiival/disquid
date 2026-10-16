module.exports = class Data1792167099494 {
    name = 'Data1792167099494'

    async up(db) {
        await db.query(`CREATE TABLE "nft_item" ("id" character varying NOT NULL, "token_id" numeric NOT NULL, "owner" text NOT NULL, "last_transfer_block" integer NOT NULL, "contract_id" character varying, CONSTRAINT "PK_f62820212723900a3c028db24ee" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "idx_nft_item_owner_aa552ac4" ON "nft_item" ("owner") `)
        await db.query(`CREATE UNIQUE INDEX "idx_nft_item_contract_token_id_ea4e5347" ON "nft_item" ("contract_id", "token_id") `)
        await db.query(`ALTER TABLE "token" ALTER COLUMN "metadata_status" DROP DEFAULT`)
        await db.query(`ALTER TABLE "nft_item" ADD CONSTRAINT "FK_9c47d11b5e58fc0c35d4c9db14f" FOREIGN KEY ("contract_id") REFERENCES "token"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
    }

    async down(db) {
        await db.query(`ALTER TABLE "nft_item" DROP CONSTRAINT "FK_9c47d11b5e58fc0c35d4c9db14f"`)
        await db.query(`ALTER TABLE "token" ALTER COLUMN "metadata_status" SET DEFAULT 'PENDING'`)
        await db.query(`DROP INDEX "public"."idx_nft_item_contract_token_id_ea4e5347"`)
        await db.query(`DROP INDEX "public"."idx_nft_item_owner_aa552ac4"`)
        await db.query(`DROP TABLE "nft_item"`)
    }
}
