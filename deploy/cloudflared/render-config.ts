// Drop the wss ingress rule when WSS_HOSTNAME is empty. Never emits 8788.
import { readFileSync, writeFileSync } from 'node:fs';

export function renderCloudflaredConfig(template: string, hostname: string): string {
  const lines = template.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.includes('${WSS_HOSTNAME}')) {
      if (hostname.length === 0) {
        const next = lines[i + 1] ?? '';
        if (next.includes('delivery:8000')) i += 1;
        continue;
      }
      kept.push(line.replaceAll('${WSS_HOSTNAME}', hostname));
      continue;
    }
    kept.push(line);
  }
  const text = `${kept.join('\n').replace(/\n+$/, '')}\n`;
  const ingress = text.slice(text.indexOf('ingress:'));
  if (ingress.includes('8788') || /admin/i.test(ingress)) {
    throw new Error('rendered cloudflared config mentions a forbidden ingress');
  }
  return text;
}

function isMain(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const templatePath = process.argv[2] ?? 'deploy/cloudflared/config.yml.tmpl';
  const outPath = process.argv[3] ?? 'deploy/cloudflared/config.yml';
  const hostname = process.env.WSS_HOSTNAME ?? '';
  writeFileSync(outPath, renderCloudflaredConfig(readFileSync(templatePath, 'utf8'), hostname));
}
