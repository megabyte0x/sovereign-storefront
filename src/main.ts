import { loadConfig } from './config.ts';
import { startSeller } from './seller/server.ts';

const config = loadConfig();
const seller = await startSeller({
  config,
  seedProduct: config.mode === 'fixture',
});

console.log(`public ${seller.publicUrl}`);
console.log(`admin ${seller.adminUrl}`);
