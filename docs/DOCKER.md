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

## First start without a configuration

If `SECRET_DESK_CONFIG` points to a file that does not exist yet and its folder is writable, the portal creates a minimal configuration and an empty inventory there and shows a first-start wizard instead of failing. There you can load the team configuration from a private GitHub repository, upload a team file, or start empty (see [Team sync](TEAM.md#team-sync-with-a-private-github-repository)). The configuration file you write by hand (below) is the alternative.

To skip the wizard, pass the repository and a token as environment variables. At the first start, with an empty inventory, the portal then sets up `teamSync`, reads the file and takes it over once:

```yaml
    environment:
      SECRET_DESK_TEAM_REPO: acme/team-config
      SECRET_DESK_TEAM_PATH: secret-desk.team.yaml
      SECRET_DESK_TEAM_BRANCH: main
      SECRET_DESK_TEAM_TOKEN: ${SECRET_DESK_TEAM_TOKEN}   # from .env (mode 600), never shown
```

The token needs *Contents: Read* on that repository only (more to push, see [Team](TEAM.md)). The variables are only used while `teamSync` is not configured; afterwards the configuration file is the source.

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

## Browser on the Pi

Providers without an API (GitHub fine-grained tokens, Supabase access tokens, see [BROWSER-AUTOMATION.md](BROWSER-AUTOMATION.md)) need a real browser. The Pi has no display, so a second container runs one: the **browser sidecar** (`ghcr.io/pineflight/secret-desk-browser`, built from [`docker/browser`](../docker/browser), `linux/amd64` and `linux/arm64`). It contains a headed Chromium on a virtual display (Xvfb), a VNC server and noVNC.

- **You sign in once per provider**, in a normal web browser on your Mac: you open the noVNC window of the sidecar, and the Chromium in it is the one secret-desk drives. Cookies live in the sidecar's profile volume and survive restarts and updates.
- **Later runs need nobody watching.** secret-desk connects to the sidecar's Chromium over the Chrome DevTools Protocol, opens its own tab, runs the recipe and closes that tab again. Other tabs and the browser stay.
- **When a provider asks again** (GitHub "Confirm access", 2FA), the run pauses exactly as on a desktop ("waiting for you in the browser window") and you complete it in the same noVNC window. Nothing else changes: you sign in, values stay in memory, a human confirms.

> **Warning: port 9222 is full control over a signed-in browser.** Whoever reaches it can read every cookie and session in the profile, open any page as you and read the tokens it shows. Never publish it (`ports:`), never proxy it (no Caddy route), never put it behind a tunnel. It stays on the compose network, and only the `secret-desk` container needs it. The same goes for the profile volume: it holds your sign-ins.

### Compose services

Add the `browser` service, a volume and a secret to the compose file above, and point the portal at it:

```yaml
services:
  secret-desk:
    # ... as above, plus:
    environment:
      SECRET_DESK_BROWSER_CDP: http://browser:9222
      # Link "Open browser" on the Connections page (the noVNC address from the Caddy route below):
      SECRET_DESK_BROWSER_VIEWER_URL: /browser/vnc.html?path=browser/websockify&autoconnect=1&resize=scale
    depends_on:
      - browser

  browser:
    image: ghcr.io/pineflight/secret-desk-browser:latest
    restart: unless-stopped
    shm_size: 512m                     # Chromium needs more than Docker's 64 MB /dev/shm
    mem_limit: 1536m                   # keeps a runaway tab from starving the Pi (4 GB)
    # No "ports:" for 9222. The Caddy route below reaches noVNC (6080) over the compose network.
    secrets:
      - vnc-password
    volumes:
      - browser-profile:/profile
    labels:
      com.centurylinklabs.watchtower.enable: "true"

secrets:
  vnc-password:
    file: /srv/tresor/secret-desk/vnc-password

volumes:
  browser-profile:
```

The VNC password file holds one line with at least 8 characters (the VNC protocol only uses the first 8). The sidecar **refuses to start without it**; there is no default password. It must be readable by the container user (UID 10001):

```bash
openssl rand -base64 12 > /srv/tresor/secret-desk/vnc-password
chmod 644 /srv/tresor/secret-desk/vnc-password   # compose mounts it read-only; the directory itself stays private
```

Instead of a named volume you can bind-mount a directory; then `sudo chown 10001:10001` it. In the portal's configuration set `automation.enabled: true` (the minimal configuration above disables it, because without the sidecar there is no browser). `SECRET_DESK_BROWSER_CDP` replaces `automation.cdpEndpoint`; `chromePath` and `profileDir` are ignored while it is set.

Check it from the Pi:

```bash
docker compose exec secret-desk node /app/packages/cli/dist/bin.js browser doctor
```

The portal shows the same under *Connections*: *Remote browser* with *Answers* or *Not reachable*.

### Caddy route to noVNC

Add a route for `/browser/*` to the `Caddyfile`. noVNC controls the whole browser, so it is protected with `basic_auth` before anything reaches the sidecar. Create the password hash once and paste it in:

```bash
docker compose run --rm caddy caddy hash-password
```

```
http://desk.local, http://192.168.1.20 {
	handle_path /browser/* {
		basic_auth {
			admin <hash printed above>
		}
		reverse_proxy browser:6080
	}
	reverse_proxy secret-desk:4747
}
```

`handle_path` removes the `/browser` prefix; Caddy proxies the WebSocket that noVNC uses on its own. Open the sidecar on your Mac at:

```
http://desk.local/browser/vnc.html?path=browser/websockify&autoconnect=1&resize=scale
```

The browser asks for the Caddy user and password, noVNC then for the VNC password. Over plain HTTP in the LAN both cross the network in clear text, see [Security and HTTPS](#security-and-https): use it only in networks you trust.

Port 6080 on the sidecar is not published; without a reverse proxy in front it must stay that way.

### Credentials: which, from where

Opening the browser takes two passwords. Neither is a provider password, and secret-desk stores neither.

| Prompt | User | Password | Where it comes from |
|---|---|---|---|
| Browser dialog *Sign in to desk.local* (HTTP Basic Auth from Caddy) | the user in the `basic_auth` block, e.g. `admin` | the plain password you hashed with `caddy hash-password` | You choose it when you set up the route. Keep it in a file on the host that only you can read, for example `browser-login` next to the compose file (mode `600`). The Caddyfile holds only the hash. |
| noVNC *Password* | none | the first line of the VNC password file | The file mounted as the compose secret `vnc-password` (`openssl rand -base64 12 > vnc-password`). |

A simple way to create and keep both on the host:

```bash
cd /srv/secret-desk                       # the folder with docker-compose.yml
umask 077
openssl rand -base64 12 > vnc-password && chmod 644 vnc-password
pw=$(openssl rand -base64 18)
printf 'user: admin\ncaddy-password: %s\nvnc-password: %s\n' "$pw" "$(cat vnc-password)" > browser-login
docker compose run --rm caddy caddy hash-password --plaintext "$pw"   # paste the hash into the Caddyfile
unset pw
```

Read them later with `cat browser-login` on the host. Never put them into the inventory, a repository or a chat.

### First sign-in to a provider

1. Open the portal, go to *Connections*, section *Browser automation*. *Remote browser* should say *Answers*.
2. Click *Open browser*. The link follows the address you opened the portal with when `SECRET_DESK_BROWSER_VIEWER_URL` is a
   path such as `/browser/vnc.html?...`.
3. Enter the Caddy user and password, then the VNC password (table above). You now see the Chromium of the sidecar.
4. Close the notices Chromium shows after a restart (*Restore pages?*: close it, do not restore). The banner about
   `--no-sandbox` is expected, see below.
5. In the address bar open the provider's sign-in page and sign in as you normally do, including 2FA. Do not let the
   browser save the password; the session cookie is what later runs need. Choose only necessary cookies in consent banners.
6. Repeat for every provider that uses a recipe. Close the tabs afterwards if you like; the sign-ins stay in the profile
   volume and survive restarts and updates.
7. Runs from the portal now open their own tab in this browser. When a provider asks again (session expired, *Confirm
   access*, 2FA), the run shows *waiting for you in the browser window*: open the browser again and complete it there.

Sign-ins end when the provider ends the session (days to weeks, depending on the provider). Then repeat step 5 for that provider.

### What is inside and what it costs

- Chromium listens for DevTools on `127.0.0.1` inside the container only. A small `socat` forwards port 9222 to the compose network. Chromium rejects requests whose `Host` header is a name instead of an IP address, so secret-desk resolves `browser` to its address before it connects.
- The VNC server listens on `127.0.0.1` only; noVNC (websockify) is the only way in. All processes run as a non-root user (UID 10001).
- Chromium runs with `--no-sandbox` by default, because its own sandbox needs user namespaces that Docker does not allow without extra privileges. The container is the boundary, and the browser only visits the sites named in the recipes. To use Chromium's sandbox, set `BROWSER_SANDBOX=1` and allow user namespaces for the container (a custom seccomp profile).
- Memory: about 250 MB idle, more with open tabs. `RESOLUTION` (default `1440x900`) sets the size of the virtual screen.
- After an unclean stop, the sidecar removes stale profile locks at start.

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

Add this service to the same compose file. Three things to know:

- Access to the Docker socket is root-equivalent on the Pi. Run Watchtower only on a machine you control, and do not add other containers to the label filter that you do not trust.
- A push to `main` reaches the Pi after about five minutes (the poll interval plus the build time of the workflow). A broken release therefore reaches the Pi too. If you want to decide yourself when to update, pin a tag such as `ghcr.io/pineflight/secret-desk:v0.1.0-12` and drop the Watchtower service.

- **The browser sidecar is not updated on every merge.** Watchtower restarts any container whose `:latest` changed, and a restart of the sidecar cuts off a sign-in a human is typing in the browser window. The release workflow therefore builds and publishes `secret-desk-browser` only when `docker/browser` changed since the previous release tag (or no sidecar image exists yet); otherwise `ghcr.io/pineflight/secret-desk-browser:latest` is not touched at all, not even re-tagged, because an unchanged image with new annotations would still be a new digest. The sidecar's version tag (`:v0.1.0-12`) names the release in which it last changed. The portal image still updates on every merge; its restart does not touch the sidecar's profile or open sign-ins. To force a new sidecar, change a file in `docker/browser`.

After an update the container restarts and prints the launch address again. The secret in it is new unless `SECRET_DESK_LAUNCH_SECRET_FILE` is set, in which case it stays the same.
