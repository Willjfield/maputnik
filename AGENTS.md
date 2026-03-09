Maputnik is a MapLibre style editor written using React and TypeScript.

To get started, install all npm packages:

```
npm install
```

Verify code correctness by running ESLint:

```
npm run lint
```

Or try fixing lint issues with:

```
npm run lint -- --fix
```

The project type checked and built with:

```
npm run build
```

To run the tests make sure that xvfb is installed:

```
apt install xvfb
```

Run the development server in the background with Vite:

```
nohup npm run start &
```

For the style-editing chat (Claude), set `ANTHROPIC_API_KEY` in `.env`. The dev server proxies requests to the Anthropic API to avoid CORS, so the key stays server-side. Do **not** set `VITE_ANTHROPIC_API_KEY` when building for commit or CI—that inlines the key into the client bundle. Use the proxy (and `ANTHROPIC_API_KEY` only) for local dev; production builds from CI have no key in the bundle. The `dist/` directory is gitignored; do not commit build output.

Then start the Cypress tests with:

```
xvfb-run -a npm run test
```

## Pull Requests

- Pull requests should update `CHANGELOG.md` with a short description of the change.
