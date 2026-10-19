#!/usr/bin/env bash
# Compare account_token against i-see-u's raw transfers over [START, END].
# usage: scripts/parity.sh [END_BLOCK] [START_BLOCK]   (both Postgres containers must be running)
set -euo pipefail
X=${1:-26106500}; ST=${2:-26104555}; OUT=$(mktemp -d)
isu() { docker exec -i i-see-u-postgres-1 psql -U iseeu -d iseeu -At -F , "$@"; }
our() { docker exec -i disquid-db-1 psql -U postgres -d squid -At -F , "$@"; }
Z="'\\x0000000000000000000000000000000000000000'::bytea"
for std in 20 721; do
    # Our decoder skips zero-value ERC-20 Transfers; ERC-721 "value" is the token id.
    if [ $std = 20 ]; then VF="and value > 0"; NAME=ERC20; else VF=""; NAME=ERC721; fi
    isu -c "with t as (select token, block_number b, \"from\" f, \"to\" r from transfers where network=1 and standard=$std $VF and block_number between $ST and $X),
            s as (select f a, token, b, 1 sc, 0 rc from t where f <> $Z union all select r, token, b, 0, 1 from t where r <> $Z)
            select '0x'||encode(a,'hex'), '0x'||encode(token,'hex'), min(b), max(b), sum(sc), sum(rc) from s group by 1,2" | LC_ALL=C sort > "$OUT/isu.csv"
    our -c "select account, token_id, first_seen_block, last_seen_block, sent_count, received_count
            from account_token where standard='$NAME' and first_seen_block <= $X" | LC_ALL=C sort > "$OUT/our.csv"
    pairs() { cut -d, -f1,2 "$1"; }
    only_isu=$(LC_ALL=C comm -23 <(pairs "$OUT/isu.csv") <(pairs "$OUT/our.csv") | wc -l)
    only_our=$(LC_ALL=C comm -13 <(pairs "$OUT/isu.csv") <(pairs "$OUT/our.csv") | wc -l)
    # Full rows only for pairs with no activity after X (their counts are complete on both sides).
    awk -F, -v x=$X '$4<=x' "$OUT/our.csv" > "$OUT/our_closed.csv"
    rows_bad=$(LC_ALL=C comm -13 "$OUT/isu.csv" "$OUT/our_closed.csv" | wc -l)
    echo "ERC-$std: pairs isu=$(wc -l < "$OUT/isu.csv") ours=$(wc -l < "$OUT/our.csv") only_isu=$only_isu only_ours=$only_our full_row_mismatch=$rows_bad/$(wc -l < "$OUT/our_closed.csv")"
done
