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

## Prepare the host

The container runs as the user `node` (UID 1000). The data directory must belong to that user, otherwise the portal cannot write inventory, vault and agent token.

```bash
sudo mkdir -p /srv/tresor/secret-desk/data
sudo chown -R 1000:1000 /srv/tresor/secret-desk/data
```

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
      SECRET_DESK_ALLOWED_HOSTS: "192.168.1.20:4747"
      SECRET_DESK_VAULT_KEY: ${SECRET_DESK_VAULT_KEY}
    volumes:
      - /srv/tresor/secret-desk/data:/data
    labels:
      com.centurylinklabs.watchtower.enable: "true"
```

`SECRET_DESK_ALLOWED_HOSTS` is a comma-separated list of additional `host:port` values the portal accepts in the `Host` and `Origin` headers, for example `192.168.1.20:4747,pi.local:4747`. Without it (or when empty) only `127.0.0.1`, `localhost` and `[::1]` with the port are accepted, and a call over the LAN address gets 403. Every entry must contain the port as the browser sends it. All other checks (DNS rebinding, `Origin`, `Sec-Fetch-Site`, launch secret, CSRF) stay in force.

Start it:

```bash
docker compose up -d
```

## Open the portal

The portal prints a one-time address with the launch secret into the container log:

```bash
docker compose logs secret-desk
```

The address starts with `http://127.0.0.1:4747/?launch=...`. Replace `127.0.0.1` with the address of the Pi, for example `http://192.168.1.20:4747/?launch=...`, and open it in your browser. The secret changes with every container start, so read the log again after each update. Do not share the address.

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

After an update the container restarts and prints a new launch secret.
