/**
 * Server identity, read from package.json so it cannot drift. A module of its
 * own so services (the remote-image User-Agent) can use it without importing
 * server.ts, which imports the tools that import those services.
 */

import { createRequire } from "module";

const pkg = createRequire(import.meta.url)("../package.json") as {
  name: string;
  version: string;
};
export const SERVER_NAME = pkg.name;
export const SERVER_VERSION = pkg.version;
