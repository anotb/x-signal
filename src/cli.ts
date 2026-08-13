import { loadConfig } from "./config.js";
import { XService } from "./service.js";

const command = process.argv[2];
const service = new XService(loadConfig());
let exitCode = 0;

try {
  if (command === "canary") {
    const result = await service.canary();
    await write(process.stdout, `${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "status") {
    const result = await service.status({ liveProbe: process.argv.includes("--live") });
    await write(process.stdout, `${JSON.stringify(result, null, 2)}\n`);
  } else {
    await write(process.stderr, "Usage: node dist/src/cli.js <canary|status> [--live]\n");
    exitCode = 2;
  }
} catch (error) {
  await write(process.stderr, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  service.close();
}

// A one-shot CLI may have opened a Playwright CDP client. Explicitly ending
// this process disconnects that client without asking the persistent sidecar
// to close Chromium.
process.exit(exitCode);

function write(stream: NodeJS.WriteStream, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
}
