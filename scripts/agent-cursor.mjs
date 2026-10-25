#!/usr/bin/env node
import { startCursorService } from "../lib/cursor-service.mjs";
const service = await startCursorService();
process.stderr.write(`Agent cursor listening on ${service.socketPath}\n`);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await service.stop();
    process.exit(0);
  });
