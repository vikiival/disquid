module.exports = class TokenMetadata1792157095213 {
    name = 'TokenMetadata1792157095213'

    // Existing tokens start PENDING so the processor's sweep backfills their metadata.
    async up(db) {
        await db.query(`ALTER TABLE "token" ADD "metadata_status" character varying(7) NOT NULL DEFAULT 'PENDING'`)
        await db.query(`CREATE INDEX "idx_token_metadata_status_eb1abad3" ON "token" ("metadata_status") `)
    }

    async down(db) {
        await db.query(`DROP INDEX "public"."idx_token_metadata_status_eb1abad3"`)
        await db.query(`ALTER TABLE "token" DROP COLUMN "metadata_status"`)
    }
}
