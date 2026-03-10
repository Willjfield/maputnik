# Deploying Maputnik with an Anthropic API proxy (key server-side only)

To run Maputnik at a URL like `https://yourdomain.com/maputnik/` and use the style-editing chat **without** putting your Anthropic API key in the frontend, do the following.

## 1. Build the app to use your proxy URL

The production build must call your own proxy path instead of the Anthropic API directly. Set the proxy URL at **build time**:

```bash
# Build with base and proxy URL (no API key is baked in)
VITE_ANTHROPIC_API_URL=/api/anthropic/messages npm run build
```

- **Base:** The build already uses base `/maputnik/` for production, so the app will work when served at `https://yourdomain.com/maputnik/`.
- **Proxy URL:** `VITE_ANTHROPIC_API_URL=/api/anthropic/messages` is compiled into the bundle so the browser sends chat requests to **your server** at that path. The key is never in the frontend.

Copy the contents of the `dist/` folder to your server (e.g. into `/var/www/wijfi.com/maputnik/` or wherever your site is served from).

## 2. Run the proxy server on Ubuntu

The proxy is a small Node.js server that forwards `POST /api/anthropic/messages` to Anthropic and adds your API key on the server.

**Install Node.js** (if needed) — use the [current LTS](https://nodejs.org/).

**Run the proxy** with the API key in the environment (never in the repo or in the build):

```bash
# From the project root (or copy server/anthropic-proxy.js to the server)
ANTHROPIC_API_KEY=sk-ant-your-key-here node server/anthropic-proxy.js
```

By default it listens on `http://127.0.0.1:3000`. To use another port:

```bash
PORT=3001 ANTHROPIC_API_KEY=sk-ant-... node server/anthropic-proxy.js
```

**Run it under systemd** so it stays up and has the key only in the environment:

1. Create a service file, e.g. `/etc/systemd/system/maputnik-anthropic-proxy.service`:

```ini
[Unit]
Description=Maputnik Anthropic API proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/maputnik
Environment=ANTHROPIC_API_KEY=sk-ant-your-key-here
Environment=PORT=3000
ExecStart=/usr/bin/node server/anthropic-proxy.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

2. Store the key securely: avoid putting the real key in the unit file. Use a separate env file with restricted permissions and load it:

```ini
EnvironmentFile=/etc/maputnik/anthropic.env
```

with `/etc/maputnik/anthropic.env` containing:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Then: `chmod 600 /etc/maputnik/anthropic.env` and `chown root:root /etc/maputnik/anthropic.env`.

3. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable maputnik-anthropic-proxy
sudo systemctl start maputnik-anthropic-proxy
sudo systemctl status maputnik-anthropic-proxy
```

## 3. Nginx configuration

Nginx should:

1. Serve the Maputnik static files under `/maputnik/`.
2. Proxy `POST /api/anthropic/messages` to the local proxy server (which adds the API key and forwards to Anthropic).

Example (snippet) for `https://wijfi.com`:

```nginx
server {
    listen 443 ssl;
    server_name wijfi.com;
    # ... your ssl_* and other settings ...

    # Maputnik static files (contents of dist/ copied to this root)
    location /maputnik/ {
        alias /var/www/wijfi.com/maputnik/;
        try_files $uri $uri/ /maputnik/index.html;
    }

    # Anthropic proxy: key stays on server
    location = /api/anthropic/messages {
        if ($request_method != POST) {
            return 405;
        }
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

- Replace `/var/www/wijfi.com/maputnik/` with the path where you put the contents of `dist/`.
- The proxy server must be listening on `127.0.0.1:3000` (or change `proxy_pass` and `PORT` to match).

Reload nginx after editing:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Summary: keeping the API key off the frontend

| Component        | Role |
|-----------------|-----|
| **Build**       | `VITE_ANTHROPIC_API_URL=/api/anthropic/messages` — frontend only knows “call my origin at this path”. No key in env at build time. |
| **Browser**     | Sends `POST /api/anthropic/messages` to your domain (same-origin). No key in HTML/JS. |
| **Nginx**       | Serves static files; forwards that POST to the local proxy. |
| **Proxy (Node)**| Receives the POST, adds `x-api-key` from `ANTHROPIC_API_KEY`, forwards to `https://api.anthropic.com/v1/messages`. Key exists only in server env. |

The Anthropic API key is only in the environment of the proxy process (e.g. via systemd `Environment` or `EnvironmentFile`), never in the repo, build, or frontend.
