# Draft upstream issue: Nym broadcasts from a testnet wallet use mainnet destinations

**Status:** Draft for user review. Do not file yet.

## Summary

With a testnet wallet configured to sync through a testnet census indexer, zingolib v6 selects the hard-coded mainnet `DESTINATION_INDEXERS` for a Nym transaction broadcast. The testnet transaction reaches mainnet indexers, which reject it as `could not contextually validate`. The transaction remains unmined even though the wallet's testnet sync path is healthy.

## Reproduction

1. Configure a zingolib v6 wallet for testnet with a testnet census sync indexer and Nym transaction transport.
2. Build a valid testnet transaction and broadcast it through the wallet's normal Nym send path.
3. Observe the destination network selected for the broadcast and the response from those destinations.

**Expected:** A testnet broadcast selects mixnet-eligible testnet census destinations. Mainnet behavior remains unchanged.

**Observed:** The send path uses the mainnet-only `DESTINATION_INDEXERS` list. Those destinations reject the testnet transaction with `could not contextually validate`; the transaction is not mined.

## Proposed direction

Choose destinations from the testnet census when the configured sync indexer belongs to that census, while retaining the existing mainnet destination selection for mainnet wallets. Cover both networks with destination-selection tests.

This draft contains no wallet material, transaction identifiers, or local file paths.
