/**
 * Documented mapping from zcash_client_backend 0.24.0 WalletRead onto
 * application Scanner / ScanCheckpoint / ChainRevision.
 *
 * Methods below are taken from
 * https://docs.rs/zcash_client_backend/0.24.0/zcash_client_backend/data_api/trait.WalletRead.html
 * and ReceivedTransactionOutput accessors in data_api.rs. Do not invent extra SDK methods.
 */
export const WALLET_READ_MAPPING = {
  crate: 'zcash_client_backend',
  version: '0.24.0',
  license: 'MIT OR Apache-2.0',
  persistence: { crate: 'zcash_client_sqlite', version: '0.22.0', license: 'MIT OR Apache-2.0' },
  zip321: { crate: 'zip321', version: '0.9.0', license: 'MIT OR Apache-2.0' },
  network: 'test',
  viewingOnly: [
    'WalletRead::get_unified_full_viewing_keys',
    'WalletRead::get_account_for_ufvk',
  ],
  chainRevision: {
    height: ['WalletRead::chain_height', 'WalletRead::block_fully_scanned'],
    id: ['WalletRead::get_block_hash', 'WalletRead::get_max_height_hash'],
  },
  scanHealth: {
    caughtUp: [
      'WalletRead::block_fully_scanned equals WalletRead::chain_height',
      'WalletRead::suggest_scan_ranges has no ScanPriority::Verify gap',
      'WalletRead::get_wallet_summary scan progress',
    ],
    confirmations: [
      'WalletRead::get_received_outputs(txid, target_height, confirmations_policy)',
      'ReceivedTransactionOutput::confirmations_until_spendable',
    ],
  },
  observations: {
    enumerateGap:
      'WalletRead::get_received_outputs requires a txid and does not list wallet history. Adapter must snapshot scan_cached_blocks results and/or zcash_client_sqlite received-note rows, then replay from ScanCheckpoint. A live-only cursor is insufficient.',
    outputIdentity: [
      'txid from the get_received_outputs request context (ReceivedTransactionOutput does not store txid)',
      'ReceivedTransactionOutput::pool_type',
      'ReceivedTransactionOutput::output_index',
    ],
    amount: 'ReceivedTransactionOutput::value',
    memo: 'WalletRead::get_memo(NoteId)',
    minedHeight: 'WalletRead::get_tx_height(txid)',
  },
  attribution: {
    selected: 'random-memo',
    reason:
      'ReceivedTransactionOutput has no recipient address. WalletRead::find_account_for_address maps to an account, not an invoice. Per-invoice diversified destinations are therefore not mappable from documented WalletRead received-output fields. Use WalletRead::get_memo against invoice.attributionRef.',
    rejected: ['amount-only', 'txid-only', 'per-invoice destination via WalletRead'],
  },
  checkpoint: {
    sellerOwned: 'ScanCheckpoint advanced only after commitReconciliation',
    replay: 'MemoryScanner.replaceSnapshot is the stand-in for an authoritative rescan covering the checkpoint range',
  },
  liveZakura: {
    label: 'zakura/regtest',
    nodeChainField: 'test',
    networkField: 'Regtest',
    publicTestnet: false,
    walletReadWired: false,
    gap:
      'GET /accounts on thus-spoke-zakura 0.2.1 omitted UFVK. This TypeScript spike does not call zcash_client_backend WalletRead or download compact blocks from lightwalletd. Live receipts are mapped through documented dashboard types onto the same Observation/ScanHealth/ChainRevision fields WalletRead would fill.',
    mapped: {
      'ChainRevision.height': 'GET /api/v1/status node.blocks / wallet_sync.fully_scanned_height (stand-in for WalletRead::chain_height / block_fully_scanned)',
      'ChainRevision.id': 'GET /api/v1/status node.bestblockhash or GET /api/v1/transactions/{txid} blockhash (stand-in for WalletRead::get_block_hash)',
      'ScanHealth.caughtUp': 'wallet_sync.state=ready and fully_scanned_height == observed_height == node.blocks (stand-in for block_fully_scanned == chain_height)',
      'Observation.amountZat': 'POST /api/v1/faucet activity.amount_zatoshi (stand-in for ReceivedTransactionOutput::value)',
      'Observation.confirmations': 'GET /api/v1/transactions/{txid} confirmations (stand-in for get_received_outputs confirmations_policy)',
      'Observation.outputId': 'txid:orchard:0 — orchard faucet txs are padded to two actions; without WalletRead::output_index the received-note index is not known',
      destination:
        'GET /api/v1/accounts unified_address for activity.to_account. Not a WalletRead ReceivedTransactionOutput field.',
      memo:
        'POST /api/v1/faucet accepts memo; CLI ths faucet does not. Memo text is not written to results or logs.',
    },
    attribution: 'destination-ua (live); random-memo remains the WalletRead-compatible path',
  },
} as const;
