#!/usr/bin/env node
import { argv } from "node:process";

const command = argv[2];

if (command === "install") {
  const { runInstaller } = await import("./install.js");
  await runInstaller();
} else if (command === "uninstall") {
  const { runUninstaller } = await import("./install.js");
  await runUninstaller();
} else if (command === "--version" || command === "-v") {
  console.log("memento-mcp v1.0.0");
} else {
  // Default: run MCP server
  await import("../index.js");
}
