#!/usr/bin/env node

import { main } from "./index.js";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
