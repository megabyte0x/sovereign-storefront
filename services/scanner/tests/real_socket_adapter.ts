import { createWalletScanner } from '../../../src/adapters/wallet-scanner.ts';

async function main(): Promise<void> {
  const socketPath = process.argv[2];
  if (!socketPath) throw new Error('socket path argument is required');
  const source = createWalletScanner({
    socketPath,
    expectedChain: {
      network: 'regtest',
      genesisHash: 'a'.repeat(64),
      consensusFingerprint: 'c'.repeat(64),
    },
    accountId: 'account',
  });
  const snapshot = await source.snapshot();
  if (!snapshot.complete || snapshot.sourceId !== 'scanner' || snapshot.accountId !== 'account') {
    throw new Error('real scanner socket snapshot was not accepted');
  }
  await source.close();
}

main().catch(() => { process.exitCode = 1; });
