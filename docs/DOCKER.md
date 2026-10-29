# Docker on a Raspberry Pi

This guide runs the portal as a container on a small always-on machine in your LAN, for example a Raspberry Pi 4B (arm64). The image `ghcr.io/pineflight/secret-desk` is built natively for `linux/amd64` and `linux/arm64` and published as a multi-arch manifest.

| Platform | Example devices | Tag |
| --- | --- | --- |
| `linux/arm64` | Raspberry Pi 4/5, Apple Silicon | `:latest-arm64` |
| `linux/amd64` | Intel/AMD PCs and servers | `:latest-amd64` |

`:latest` and `:<tag>` (for example `:v0.1.0-12`) pick the matching platform automatically. Use the single-platform tags only if you need a fixed assignment. The packages are public, so no `docker login` is needed.

The portal still has no user accounts. Access is protected by the launch secret, the session cookie and the host check, so publish it to your LAN only, never to the internet. Read [Security model](SECURITY-MODEL.md#access-to-the-portal) first.

## What does not work in a container

Browser automation (the visible Chrome of the [recipes](RECIPES.md)) needs a display and a browser on the machine, and the OS keychain does not exist in the container. Providers with an API and the manual paste flow work. The vault key therefore comes from `SECRET_DESK_VAULT_KEY`.

## Find the launch address

The portal only opens for someone who has the launch secret. The secret is part of an address that the portal prints into its log when it starts. In a container you read that log:

```bash
docker compose logs secret-desk
```

(or `docker logs <container name>` if you did not use compose). Look for this line:

```
secret-desk: Portal oeffnen unter
  http://127.0.0.1:4747/?launch=<secret>
```

The portal does not know under which address you reach it, so it always prints `127.0.0.1:4747`. Keep everything from `?launch=` and replace the start with your own address:

- Port published directly on the host: `http://192.168.1.20:4747/?launch=<secret>`
- Behind a reverse proxy on port 80 (see below): `http://desk.local/?launch=<secret>`

By default a new secret is created at every container start, so read the log again after every restart and after every automatic update. With `SECRET_DESK_LAUNCH_SECRET_FILE` set (the compose file below does that) the secret is created once and stored in that file (mode 600), so the address stays the same; the price is a permanent secret on disk. If you remove the variable, every start creates a new secret and you must read the log each time. The page removes the secret from the address bar after opening. Do not share the address and do not paste it into chats or tickets: whoever has it can open the portal.

## Prepare the host

The container runs as the user `node` (UID 1000). The data directory must belong to that user, otherwise the portal cannot write inventory, vault and agent token.

```bash
sudo mkdir -p /srv/tresor/secret-desk/data
sudo chown -R 1000:1000 /srv/tresor/secret-desk/data
```

Put the configuration into the volume, because the image contains no configuration file. Without `SECRET_DESK_CONFIG` the portal looks for `/app/secret-desk.config.yaml`, which does not exist, and stops with `ENOENT`. A minimal `/srv/tresor/secret-desk/data/config/secret-desk.config.yaml` for the container (the inventory file `inventory.yaml` sits next to it, see [Configuration](CONFIGURATION.md)):

```yaml
inventory: ./inventory.yaml
github:
  owner: your-organization
  auth: { type: pat, source: { type: env, name: GITHUB_TOKEN } }
automation:
  enabled: false
policy:
  envRoots: []
```

`automation.enabled: false` because there is no browser in the container, and `envRoots` stays empty because the container has no project folders to write `.env` files into. The vault file keeps its default location below `/data`. The files must belong to UID 1000 like the rest of the data directory.

Create the vault key once and keep it readable for your user only. Without this key the vault cannot be opened again, so back it up separately from the data.

```bash
cd /srv/tresor/secret-desk
printf 'SECRET_DESK_VAULT_KEY=%s\n' "$(openssl rand -base64 32)" > .env
chmod 600 .env
```

## Compose file

Replace `192.168.1.20` with the LAN address of the Pi (a fixed address or a DHCP reservation). The port is published on that address only, not on `0.0.0.0`.

```yaml
services:
  secret-desk:
    image: ghcr.io/pineflight/secret-desk:latest
    restart: unless-stopped
    ports:
      - "192.168.1.20:4747:4747"
    environment:
      SECRET_DESK_CONFIG: /data/config/secret-desk.config.yaml
      SECRET_DESK_ALLOWED_HOSTS: "192.168.1.20:4747,raspberrypi.local:4747"
      SECRET_DESK_VAULT_KEY: ${SECRET_DESK_VAULT_KEY}
      # Keeps the launch secret across restarts (stored in this file, mode 600). Remove this line
      # for a new secret at every start; then read the address from the log each time.
      SECRET_DESK_LAUNCH_SECRET_FILE: /data/launch-secret
    volumes:
      - /srv/tresor/secret-desk/data:/data
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4747/api/session').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
```

The health check only asks whether the portal answers (any status below 500, usually 401 without the launch secret); it sends no secret. The container starts without internet access, nothing is downloaded at start.

`SECRET_DESK_ALLOWED_HOSTS` is a comma-separated list of additional `host:port` values the portal accepts in the `Host` and `Origin` headers, for example `192.168.1.20:4747,pi.local:4747`. Without it (or when empty) only `127.0.0.1`, `localhost` and `[::1]` with the port are accepted, and a call over the LAN address gets 403. Every entry must equal the `Host` header the browser sends exactly: without a port for port 80 (HTTP) or 443 (HTTPS), otherwise with the port, as in the examples here. To use the mDNS name of the Pi, add `<hostname>.local:4747` as shown above (replace `raspberrypi` with the hostname of the Pi) and open the portal under that name. All other checks (DNS rebinding, `Origin`, `Sec-Fetch-Site`, launch secret, CSRF) stay in force.

Start it, then read the launch address from the log:

```bash
docker compose up -d
# Launch address (replace 127.0.0.1:4747 with your own address):
docker compose logs secret-desk
```

## Open the portal

Read the address from the log as described in [Find the launch address](#find-the-launch-address), replace `127.0.0.1:4747` with your own address, for example `http://192.168.1.20:4747/?launch=...`, and open it in your browser. The address is printed at every start, directly after the server is ready. With `SECRET_DESK_LAUNCH_SECRET_FILE` (set in the compose file above) the secret is created once, written to that file with mode 600 and reused after restarts and updates, so a bookmarked address keeps working. Treat the file like a password: anyone who can read it can open the portal from your LAN. Do not share the address.

## Reaching the portal without a port: a `.local` name (reverse proxy)

This section is optional. It makes the portal available as `http://desk.local` instead of `http://192.168.1.20:4747`. A reverse proxy on port 80 can also serve several services on one machine and tell them apart by host name. It was developed on a Raspberry Pi (Raspberry Pi OS, Docker Compose); the HTTP operation described here is only partly tested, see the notes in each step.

### 1. A `.local` alias with mDNS

Install the Avahi tools and publish an alias for the LAN address of the machine:

```bash
sudo apt install avahi-daemon avahi-utils
```

Create `/etc/systemd/system/avahi-alias-desk.service`:

```ini
[Unit]
Description=mDNS alias desk.local
After=avahi-daemon.service network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/avahi-publish -a -R desk.local 192.168.1.20
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now avahi-alias-desk.service
ping desk.local
```

`192.168.1.20` is the (fixed) LAN address of the machine. Use another name than `<hostname>.local` for the alias; the hostname itself is already published by Avahi. macOS and most Linux desktops resolve `.local` on their own, Windows 10/11 usually does as well (otherwise install Bonjour). Android often does not resolve `.local`; use the DNS of your router or a hosts entry instead. Some networks and VLANs block mDNS.

### 2. Caddy in front of the portal

Remove the `ports` entry from the `secret-desk` service (the portal is then reachable only inside the compose network) and add Caddy. Port 80 is published on the LAN address only:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "192.168.1.20:80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
```

`Caddyfile` next to the compose file:

```
http://desk.local, http://192.168.1.20 {
	reverse_proxy secret-desk:4747
}
```

The `http://` prefix stops Caddy from switching to HTTPS on its own. Set the allowed hosts **without a port**, because a browser sends no port for port 80:

```yaml
      SECRET_DESK_ALLOWED_HOSTS: "desk.local,192.168.1.20"
```

Every entry must equal the `Host` header exactly (with a port only for a non-standard port). Caddy passes the `Host` header on unchanged, and the portal keeps checking host, `Origin`, `Sec-Fetch-Site`, launch secret and CSRF token. The session cookie has no `Secure` attribute (checked in the code and covered by a test), so the portal works over plain HTTP. The complete flow through Caddy is not covered by an automated test.

Open `http://desk.local/?launch=<secret>`, see [Find the launch address](#find-the-launch-address). Further services can get their own block in the same `Caddyfile` with their own alias name.

### Security and HTTPS

HTTP in the LAN is not encrypted: the launch secret in the address and the tokens you enter in the portal cross the network in clear text. Use it only in networks you trust, and never forward the port to the internet. HTTPS is possible, for example with Caddy `tls internal` (own certificate authority, which every device must trust), but is not described or tested here.

### Troubleshooting

- **403 "Host nicht erlaubt":** the name or address you typed is not in `SECRET_DESK_ALLOWED_HOSTS`, or the port does not match.
- **502 from Caddy:** the portal is not ready yet, or the service name in the `Caddyfile` is wrong. Check `docker compose logs secret-desk`.
- **The name does not resolve:** this is mDNS, check with `ping desk.local` and the notes in step 1.

## Restart behavior

`restart: unless-stopped` starts the container again after a crash and after a reboot, as long as Docker itself starts at boot (`sudo systemctl enable docker`). Because Docker keeps its data and the volume on the external disk, Docker must not start before the disk is mounted. Add a drop-in with `sudo systemctl edit docker.service`:

```ini
[Unit]
RequiresMountsFor=/srv/tresor
```

Without it, Docker can come up on an empty mount point after a reboot and create a fresh, empty data directory on the SD card.

## Automatic updates with Watchtower

Every push to `main` publishes a new `:latest` image (see [release workflow](../.github/workflows/release.yml)). The container `nickfedor/watchtower` pulls it and restarts only containers that carry the label `com.centurylinklabs.watchtower.enable=true`:

```yaml
  watchtower:
    image: nickfedor/watchtower
    restart: unless-stopped
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_POLL_INTERVAL: "300"
      WATCHTOWER_CLEANUP: "true"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

Add this service to the same compose file. Two things to know:

- Access to the Docker socket is root-equivalent on the Pi. Run Watchtower only on a machine you control, and do not add other containers to the label filter that you do not trust.
- A push to `main` reaches the Pi after about five minutes (the poll interval plus the build time of the workflow). A broken release therefore reaches the Pi too. If you want to decide yourself when to update, pin a tag such as `ghcr.io/pineflight/secret-desk:v0.1.0-12` and drop the Watchtower service.

After an update the container restarts and prints the launch address again. The secret in it is new unless `SECRET_DESK_LAUNCH_SECRET_FILE` is set, in which case it stays the same.
