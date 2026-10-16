module.exports = class Data1792155042177 {
    name = 'Data1792155042177'

    async up(db) {
        await db.query(`CREATE TABLE "account_token" ("id" character varying NOT NULL, "account" text NOT NULL, "standard" character varying(7) NOT NULL, "first_seen_block" integer NOT NULL, "last_seen_block" integer NOT NULL, "sent_count" integer NOT NULL, "received_count" integer NOT NULL, "token_id" character varying, CONSTRAINT "PK_a55842d3341d42534e39f85e931" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "idx_account_token_token_9341bbb4" ON "account_token" ("token_id") `)
        await db.query(`CREATE UNIQUE INDEX "idx_account_token_account_standard_token_2886f3bb" ON "account_token" ("account", "standard", "token_id") `)
        await db.query(`CREATE TABLE "token" ("id" character varying NOT NULL, "first_seen_block" integer NOT NULL, "name" text, "symbol" text, "decimals" integer, CONSTRAINT "PK_82fae97f905930df5d62a702fc9" PRIMARY KEY ("id"))`)
        await db.query(`CREATE TABLE "block" ("id" character varying NOT NULL, "number" integer NOT NULL, "hash" text NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_d0925763efb591c2e2ffb267572" PRIMARY KEY ("id"))`)
        await db.query(`CREATE UNIQUE INDEX "idx_block_number_02904b31" ON "block" ("number") `)
        await db.query(`ALTER TABLE "account_token" ADD CONSTRAINT "FK_b2866828ca401887e5b91330078" FOREIGN KEY ("token_id") REFERENCES "token"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
    }

    async down(db) {
        await db.query(`ALTER TABLE "account_token" DROP CONSTRAINT "FK_b2866828ca401887e5b91330078"`)
        await db.query(`DROP INDEX "public"."idx_block_number_02904b31"`)
        await db.query(`DROP TABLE "block"`)
        await db.query(`DROP TABLE "token"`)
        await db.query(`DROP INDEX "public"."idx_account_token_account_standard_token_2886f3bb"`)
        await db.query(`DROP INDEX "public"."idx_account_token_token_9341bbb4"`)
        await db.query(`DROP TABLE "account_token"`)
    }
}
