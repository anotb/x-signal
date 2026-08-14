# Connect a client

Start the Compose stack and sign in to X before connecting a client. The local MCP endpoint is:

```text
http://127.0.0.1:7345/mcp
```

## Codex

Choose either the direct MCP setup or the plugin. The plugin already includes the same MCP connection.

### Add the MCP server directly

The Codex desktop app and IDE extension expose MCP server settings. Add a Streamable HTTP server named `x-signal`, use the URL above, save, and restart the client.

For CLI or file-based configuration, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.x-signal]
url = "http://127.0.0.1:7345/mcp"
tool_timeout_sec = 900
```

Use `/mcp` or the MCP settings screen to confirm that X Signal is connected. The official [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp) documents the shared configuration.

### Install the local plugin

The plugin adds four optional skills for research, feeds and threads, monitoring, and setup.

From a terminal in the repository root, register it as a local marketplace:

```bash
codex plugin marketplace add .
```

In the CLI, open `/plugins`; in the desktop app, open the Plugins Directory. Find **X Signal**, install it, and start a new task. Keep the Compose stack running while using it.

### Advanced: stdio

The normal installation uses the Compose HTTP service. If a client specifically requires stdio, stop the HTTP app, leave the browser running, and build the local Node app:

```bash
docker compose stop x-signal
docker compose up -d browser
npm ci
npm run build
```

Configure that client to spawn `npm run stdio` with its working directory set to this repository. The first command above stops the Compose HTTP app so the client-spawned stdio process is the only scheduler attached to the browser. Run `docker compose up -d x-signal` when you want the normal HTTP service again.

## ChatGPT web

ChatGPT web cannot connect to localhost directly. The included Secure MCP Tunnel profile is the normal private connection for a personal installation.

Developer-mode custom MCP apps are currently supported on ChatGPT web only, not in the native ChatGPT mobile apps. Use ChatGPT web to configure and run X Signal. A native mobile app may report an active-organization-required tunnel error before it dispatches any request to the tunnel; reconnecting the app, rotating the runtime key, or rebuilding X Signal will not resolve that platform limitation. See OpenAI's [developer mode and custom MCP app availability](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta).

### Configure the stable tunnel

1. Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Create a tunnel, include the Platform organization that owns it, and associate the exact ChatGPT workspace where you will create the app.
2. In [Platform API keys](https://platform.openai.com/settings/organization/api-keys), create a dedicated restricted runtime key. Give it only **Tunnels → Read, Use**; leave model, file, assistant, and other permissions at **None**.
3. From the repository, run:

```bash
npm run tunnel:secure:configure
docker compose --profile chatgpt up -d --build --wait
```

The first command accepts the tunnel ID, its owning Platform organization ID, and the runtime key through a hidden prompt. It writes both IDs to ignored `.env` and the key to ignored `.secrets/openai-tunnel-api-key`; none of these values belongs in a plugin file, issue, screenshot, or commit. The organization ID removes ambiguity for accounts that belong to multiple Platform organizations. The second command starts the pinned multi-architecture `tunnel-client` beside X Signal and waits for a successful control-plane poll.

Check it without exposing either credential:

```bash
npm run tunnel:secure:check
docker compose --profile chatgpt ps
curl -fsS http://127.0.0.1:7346/readyz
```

The runtime key is only for the outbound tunnel control plane. X Signal does not use it to call an OpenAI model.

### Create the ChatGPT app

1. In ChatGPT, open **Settings → Security and login** and turn on **Developer mode**.
2. Open **Plugins**, select the plus button, and create an app.
3. Enter a user-facing name and description.
4. Choose **Tunnel**, then select the configured tunnel.
5. Review the 13 discovered X Signal actions.
6. Start a new chat and add X Signal from the tools menu.

If the tunnel is not listed, confirm that it includes the current ChatGPT workspace and that the app creator has **Tunnels Read + Use**. New role assignments can take time to propagate. Keep the tunnel sidecar healthy while creating or refreshing the app.

### Short-lived fallback

For a one-session test when Secure MCP Tunnel is unavailable, install `cloudflared` and run:

```bash
npm run tunnel:chatgpt
```

The command creates a random protected path and a disposable HTTPS URL. For this fallback only, choose **Server URL**, paste the complete URL, and select **No Auth**. The URL expires when the command stops, so the ChatGPT app will need a new URL next time. MCP traffic passes through Cloudflare while the fallback is open.

Treat the printed URL as a temporary credential. Never tunnel port 7345 directly. Use **Refresh** in the ChatGPT plugin settings after changing tool schemas or descriptions.

Developer Mode availability can depend on the account and workspace. See OpenAI’s [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) guide.

## MCP Inspector

Maintainers can inspect the local contract after installing dependencies:

```bash
npm ci
npm run inspector
```

The Inspector should list 13 tools and no UI resource.
