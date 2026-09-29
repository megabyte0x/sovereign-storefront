# Pi host inventory

Non-secret facts only. Recorded 2026-09-26 over `tailscale ssh home@home`. No credentials, tokens, viewing keys, or tunnel material.

| Fact | Value |
|---|---|
| Tailscale SSH | `home@home` |
| Hostname | `home` |
| Model | Raspberry Pi 5 Model B Rev 1.1 |
| Architecture | aarch64 |
| OS | Debian GNU/Linux 13 (trixie); Raspberry Pi OS image, pi-gen reference 2026-04-21 |
| Kernel | `6.18.50+rpt-rpi-2712` |
| Disk | NVMe SSD `nvme0n1`, model TS256GMTE300S, 238.5G, rotational 0, transport nvme |
| Root filesystem | `/dev/nvme0n1p2` ext4 on `/` |
| Free space | 57114914816 bytes available (53.2 GiB), 77% used. Above the 40 GB floor. |
| State directory | `/srv/ssf` mode 0750, owner `home`, group `root` |
| State filesystem | `findmnt -T /srv/ssf` → `/` on `/dev/nvme0n1p2` ext4 (the SSD) |
| Docker | 29.8.1 (client and server) |
| Compose | v5.5.1 |
| Docker data-root | `/var/lib/docker`, same SSD filesystem `/dev/nvme0n1p2` |
| unattended-upgrades | 2.12 installed and enabled. `/etc/apt/apt.conf.d/20auto-upgrades` sets package-list updates and unattended upgrades to 1. `apt-daily.timer` and `apt-daily-upgrade.timer` are enabled. Automatic reboot is unset (package default false). `/etc/apt/apt.conf.d/52unattended-upgrades-rpi` adds the Raspberry Pi Foundation origin; Debian security origins stay allowed. |
| cloudflared | 2026.1.1 is installed. An origin cert file is present at mode 0600. Contents were not recorded. The cert zone is `agentcortex.space`, not `agentmascot.app`. |
| Tunnel | Name `ssf-store`. Id `c051f8f2-00fa-4b40-b3eb-7d2e39ddee11`. Credentials file `/srv/ssf/secrets/c051f8f2-00fa-4b40-b3eb-7d2e39ddee11.json`, mode 0600, owner `home`, group `home`. Not copied off the Pi. Contents not recorded. |
| store CNAME | Does not exist. DoH for `store.agentmascot.app` is NXDOMAIN. `wss.agentmascot.app` was not created. |
| Zone settings | Not read and not changed for `agentmascot.app`. Cert token cannot see that zone and was rejected for zone settings (HTTP 403). |

No router ports were opened. Tunnel `ssf-store` exists. `store.agentmascot.app` CNAME does not exist. No Cloudflare zone settings were changed.
