# Spike results

This directory holds **sanitized evidence only**.

Probe outputs may be saved here after secrets and identifying payment data have been stripped. Do not copy wallet or node data into the repository.

The following are prohibited in saved evidence:

- private keys
- seeds
- payment URIs
- memos
- invoices
- buyer credentials

If a probe produces any of the above, redact it before writing to this directory. Runtime state belongs under ignored paths (`spikes/**/data/`, `spikes/**/runtime/`, `spikes/**/wallets/`, `seller-data/`), never here.
