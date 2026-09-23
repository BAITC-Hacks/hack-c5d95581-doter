# VPS deployment

The app runs in an isolated Docker Compose project behind nginx at
`https://hackalem.s-madaminov.tech`. PostgreSQL uses its own persistent named volume.
The application binds only to `127.0.0.1:13000`; PostgreSQL has no host port.

## Runtime configuration

Keep runtime secrets outside the Git checkout, in `/opt/hackalem-voice-router/.env`
with mode `600`. Set the two provider API keys, model IDs, `PORT=13000`,
`BIND_ADDRESS=127.0.0.1`, and a generated URL-safe `POSTGRES_PASSWORD`.
Compose configures the internal database URL. Never copy a real `.env` into an image.

Build and run a tested release from `/opt/hackalem-voice-router/current`:

```sh
docker compose --env-file /opt/hackalem-voice-router/.env -p hackalem-voice-router up -d --build
```

nginx configuration is in `deployment/nginx.conf`. Use a separate virtual host;
validate with `nginx -t` before reloading. Its Basic Auth credential is generated
outside Git, stored as a password hash on the server, and shared privately with
judges. It protects the paid voice APIs as well as the demo page. Session history
additionally requires the owning browser's HTTP-only cookie.

Certbot obtains and renews the TLS certificate with the webroot
`/opt/hackalem-voice-router/acme`. Keep the HTTP challenge location accessible and
reload nginx after renewal.

## Verification and rollback

Verify the container health, authenticated HTTPS response and WebSocket upgrade,
then check that an audit session survives application and PostgreSQL restarts.
Confirm a different browser cannot read another browser's history. Voice-provider
calls are separate paid checks; a healthy HTTP response does not prove acoustic quality.

Releases are archived by commit under `/opt/hackalem-voice-router/releases/`.
To roll back application code, point `current` at the previous tested release and
run the same Compose command. Keep the project name and database volume unchanged.
Do not run `docker compose down -v`: that deletes the audit database. If a new nginx
configuration fails validation, retain the previous target-site configuration and
leave unrelated sites untouched.
