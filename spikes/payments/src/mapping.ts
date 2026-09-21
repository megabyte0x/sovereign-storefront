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
} as const;
