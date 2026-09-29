# Replica host inventory

Non-secret facts only. Recorded 2026-09-26 over `tailscale ssh root@ssf-replica`. No credentials, tokens, viewing keys, or tunnel material.

| Fact | Value |
|---|---|
| Provider | Hetzner CX23 (KVM). Observed 2 vCPU, 3814 MiB RAM, 38G disk. |
| Location | Helsinki. Metadata availability zone `hel1-dc2`, region `eu-central`. |
| Tailscale SSH | `root@ssf-replica` |
| Hostname | `sovereign-store` |
| Tailnet name | `ssf-replica` (`ssf-replica.tail987709.ts.net`) |
| Tailscale IPv4 | `100.114.129.39` |
| Architecture | x86_64 |
| OS | Ubuntu 26.04.1 LTS (`resolute`) |
| Kernel | `7.0.0-30-generic` |
| Disk | `/dev/sda1` ext4 on `/`, 38G, about 33G free |
| State directory | `/srv/ssf` mode 0750, owner `root`, group `root` |
| State filesystem | `findmnt -T /srv/ssf` → `/` on `/dev/sda1` ext4 |
| Docker source | Official apt `https://download.docker.com/linux/ubuntu` suite `resolute` component `stable`. Ubuntu `docker.io` and `docker-compose-v2` were removed; they conflict with this install. |
| Docker Engine | `docker-ce` 5:29.8.1-1~ubuntu.26.04~resolute (client and server 29.8.1) |
| Compose plugin | `docker-compose-plugin` 5.5.1 (`docker compose version` 5.5.1) |
| Buildx plugin | `docker-buildx-plugin` 0.37.1 |
| containerd | `containerd.io` 2.3.6-1~ubuntu.26.04~resolute |
| Docker data-root | `/var/lib/docker`, same filesystem `/dev/sda1` |
| unattended-upgrades | 2.12ubuntu9 installed and enabled. `/etc/apt/apt.conf.d/20auto-upgrades` sets package-list updates and unattended upgrades to 1. `apt-daily.timer` and `apt-daily-upgrade.timer` are enabled. Docker's apt origin is not added to the unattended allowlist. |
| ufw | Active and enabled on boot. Default deny incoming, allow outgoing, deny routed. Only allow is `in` on `tailscale0` (IPv4 and IPv6). No public allow rules. |
| Public addresses | `2.29.21.235/32` and `2a01:4f9:c010:96df::1/64` on `eth0`. No socket is bound to either address. |
| Key expiry | Disabled for this node (`KeyExpiry` none). Not re-asked; already verified 2026-09-26. |

`sshd` still listens on `0.0.0.0:22` and `[::]:22` (OS). ufw does not allow that traffic off `tailscale0`. A laptop TCP connect to the public IPv4 port 22 did not succeed. Hetzner firewall 22/tcp was already removed (verified 2026-09-26); that check was not repeated in the Hetzner console.

Do not `apt purge docker.io`. The package is config-files only. Its purge handler would have deleted `/var/lib/docker` via a saved script; that script was removed.
