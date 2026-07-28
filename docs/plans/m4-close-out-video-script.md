# Close-out video — recording script (Preview)

Target ~4 min (Catalyst limit is 2–5). Recorded on Cardano Preview.

Host ports below come from `offchain/feeder/.env` (`INDEXER_HOST_PORT=3023`,
`GRAFANA_HOST_PORT=3022`, `FEEDER_HOST_PORT=8080`) — the host side Docker binds.
`INDEXER_PORT=3001` in `offchain/indexer/.env` is only the container-internal
listen port; Docker remaps it to `3023` on the host. Adjust if your ports differ.

## Part 0 — Preparation (before recording)

**a) Configure `offchain/feeder/.env` and `offchain/cli/.env` for Preview** (same
values in both):

- `CARDANO_NETWORK=Preview`
- `BLOCKFROST_PROJECT_ID_TESTNET=` your Blockfrost Preview key
- `CARDANO_WALLET_SEED_TESTNET=` operator wallet (funded from the Preview faucet)
- `DIA_WS_CREDENTIAL_TESTNET=` DIA testnet WS credential
- `DIA_AUTHORIZED_PRIVATE_KEY_TESTNET=` (in `cli/.env` only) — the demo signer

**b) Bring up the verified Preview deployment (17 live feeds) and skip the sync
backlog:**

```bash
cd offchain
make build
make restart-latest RUN_ID=20260608-040304 MONITORING=1
```

`restart-latest` reseeds the scanner checkpoint to the current chain tip, so the
feeder becomes ready in seconds instead of replaying weeks of blocks from an old
run (which would otherwise sit at `/health/ready` = 503 while it catches up).

The consumer demo and any indexer-calling script default to
`http://localhost:3001` (the container-internal port). Point them at your host
port for the session:

```bash
export INDEXER_URL=http://localhost:3023
```

**c) Verify everything responds BEFORE hitting REC:**

```bash
curl -fsS http://localhost:3023/v1/health | jq          # tip + pairCount (~17)
curl -fsS http://localhost:3023/v1/pairs  | jq '.pairs | length'
curl -fsS http://localhost:8080/health/ready            # feeder ready (200)
```

**d) Have open:** a large terminal, <http://localhost:3023/docs>, Grafana
<http://localhost:3022>, and <https://preview.cardanoscan.io>.

## Part 1 — Recording, segment by segment

### Segment 1 — Intro (~20s)

- On screen: the repo README or a simple title.
- Say: *"This is the DIA Oracles integration on Cardano — Milestone 4. On-chain
  price contracts, a feeder publishing DIA prices, a monitoring stack, and — new
  in M4 — a consumer-facing indexer and an example consumer contract. I'll show it
  operating end-to-end on Cardano Preview."*

### Segment 2 — The live oracle (feeder + indexer) (~45s)

```bash
curl -s http://localhost:3023/v1/pairs | jq '.pairs[] | {symbol, price, utxoRef}'
```

- Say: *"The indexer reads the live on-chain state — here are the published feeds,
  each with its latest price and the exact UTxO a dApp references. This is the
  chain talking, not a cache."*
- On screen: open <http://localhost:3023/docs> and show the Swagger (`/v1/pairs`,
  `/v1/protocol/fees`).
- Say: *"Everything is documented and interactive here, including the on-chain
  protocol fee — what an update costs."*

### Segment 3 — The consumer reads a feed (the key part) (~60s)

**What the contract does** (`example_oracle_consumer.ak`): it locks funds that can
be spent only while a chosen DIA feed reports a price at or above a floor the dApp
sets (`min_price`). On a spend it (1) takes the oracle's Pair UTxO as a read-only
**reference input**, (2) **authenticates** it by requiring that UTxO to carry the
feed's **Pair NFT** — a token only the protocol can mint, which proves the price is
the real oracle's, not a forgery — and (3) allows the spend **only if
`price >= min_price`**. The demo reads the live price, then tries a floor just
ABOVE it (rejected — the tx won't even build) and just BELOW it (accepted — the
spend confirms on-chain).

```bash
cd offchain
bash indexer/src/examples/run-consumer-demo-emulator.sh
```

- Say: *"Now the net-new piece: an example Aiken contract that consumes a feed. It
  reads the referenced price, authenticates it by the Pair NFT, and gates its
  spend — it accepts when the price clears the threshold and rejects when it
  doesn't. Watch both cases."*
- On screen: highlight the spend that ACCEPTS and the one that REJECTS.
- Optional, real on-chain (~30s more):

```bash
cd offchain
make stop-feeder
INDEXER_URL=http://localhost:3023 bash indexer/src/examples/run-consumer-demo-onchain.sh
make start-feeder
```

- Say (while the two attempts run): *"This is the pattern any Cardano dApp would
  use to consume a DIA feed. The contract holds locked funds, and the rule to
  unlock them is simple — the DIA price for this pair must be at or above a
  threshold the dApp chooses. The important part is trust: it reads the price from
  the oracle's own UTxO, referenced read-only, and it checks that UTxO carries the
  oracle's Pair NFT — a token only our protocol can mint — so the price can't be
  forged. Watch the two cases against the live BTC/USD price. First it sets the
  threshold just above the current price: the price doesn't clear it, so the
  contract rejects the spend and the transaction can't even be built. Then it sets
  the threshold just below the current price: now the price clears, the contract
  accepts, and the spend confirms on-chain. Same contract, same feed — the only
  thing that changed is whether the live price met the condition."*

### Segment 4 — Monitoring (~30s)

- On screen: Grafana <http://localhost:3022> → Overview, Transactions, Operational
  Cost, Wallets.
- Say: *"The deployment is tracked in real time — oracle updates, transaction
  latency and success, operational cost, and wallet health, plus alerts. This is
  the monitoring stack from Milestone 3, extended with provider-quota tracking."*

### Segment 5 — On-chain verification (~25s)

```bash
curl -s http://localhost:3023/v1/pairs | jq -r '.pairs[0].utxoRef'
```

- On screen: take the tx hash (the part before `#`) and open
  `https://preview.cardanoscan.io/transaction/<hash>`.
- Say: *"Every update is verifiable by anyone — here's a confirmed oracle update on
  the public Cardano Preview explorer."*

### Segment 6 — How a developer installs/accesses it (E2E) (~40s)

- On screen: show these commands as text — the full flow for a fresh clone (which
  uses the default port `3001`). This is **illustrative**: read it, don't run it
  live (you already have the repo, and a clone can't be created inside an existing
  one).

```bash
git clone https://github.com/diadata-org/dia-cardano-oracle.git
cd dia-cardano-oracle/offchain
cp feeder/.env.example feeder/.env
# in feeder/.env keep CARDANO_NETWORK=Preview and set your provider key:
#   BLOCKFROST_PROJECT_ID_TESTNET=<your Blockfrost Preview key>
#   MAIN=~/sources/reposUbuntu/PROTOFIRE/DIA/dia-cardano-oracle/offchain/feeder/.env
#   sed -i "s|^BLOCKFROST_PROJECT_ID_TESTNET=.*|$(grep -m1 '^BLOCKFROST_PROJECT_ID_TESTNET=' "$MAIN")|" feeder/.env
make up-indexer                          # builds the image on first run, then starts the indexer
curl -s localhost:3001/v1/pairs | jq     # every live feed (fresh clone defaults to 3001)
# then open http://localhost:3001/docs in a browser — the API reference
```

- For a live shot here, use your already-running instance on its host port
  `3023`: run `curl -s localhost:3023/v1/pairs | jq` and open
  <http://localhost:3023/docs> manually in a browser (the `open` command may fail
  under WSL).
- Say: *"Any developer can do this in minutes: clone the repo, bring up the indexer
  with one command, and query the live feeds — with a provider key alone, no wallet
  needed to read. Full docs, the consumer contract, and the fee model are all in
  the repository."*

### Segment 7 — Close (~15s)

- On screen: the repo / the PoA.
- Say: *"That's Milestone 4: DIA oracles live on Cardano, a consumer-facing
  indexer, an example consumer contract, full monitoring, and complete developer
  documentation — all public and verifiable in the repository. Thanks for
  watching."*

## Tips

- Record at 1080p, large terminal font, light theme.
- Run the emulator demo once before recording so it's cached and instant on camera.
- To skip funding/running the feeder: use `make up-indexer` (read-only) — you still
  show pairs, docs, existing dashboards, and Cardanoscan. The emulator consumer
  demo needs no wallet.
- Under WSL, open URLs in a Windows browser manually — the `open` command fails
  with harmless `dbus` errors (no display in WSL).
- Upload to YouTube or Vimeo (Catalyst requirement), 2–5 min, public link.
