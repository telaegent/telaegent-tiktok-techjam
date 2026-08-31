#!/usr/bin/env node

// Keep production startup cross-platform. Shell assignments such as
// NODE_ENV=production do not work in the default Windows command shell.
process.env.NODE_ENV = "production";
await import("../apps/server/dist/index.js");
