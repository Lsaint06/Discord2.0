# desktop

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

Requires the backend from [`../server`](../server/README.md) to be running.

### Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `RENDERER_VITE_SERVER_URL` | `.env.development` (committed default), `.env.*.local` (git-ignored), or shell | Backend base URL, e.g. `http://192.168.1.50:3001`. Compiled into the renderer and used to generate the CSP `connect-src`. **Public — never put secrets here.** See [`.env.example`](.env.example). |
| `D2_PROFILE` | shell, at launch | Optional isolated profile name (e.g. `alice`) so several clients can run on one PC. |

Development-only: the dev-identity session token is stored in renderer `localStorage`. Production should move credentials to the main process (Electron `safeStorage`).

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
