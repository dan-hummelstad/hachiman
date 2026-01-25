# my-app

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```


## Opus electron runtime issue:
If getting a runtime import error of the following:
```
Uncaught Error: Cannot find module '.../hachiman/node_modules/.pnpm/@discordjs+opus@0.10.0_encoding@0.1.13/node_modules/@discordjs/opus/prebuild/electron-v39.2-napi-v3-darwin-arm64-unknown-unknown/opus.node'
Require stack:
```

A simple workaround is to just rename the prebuild folder to what is expected.
``node-v127-napi-v3-darwin-arm64-unknown-unknown -> electron-v39.2-napi-v3-darwin-arm64-unknown-unknown``

