#!/usr/bin/env node
// Runs the GoMining Hub MCP server over stdio. See src/core/config.js for the environment variables.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromEnv } from '../core/config.js';
import { createServer } from './server.js';

const config = fromEnv();
await createServer(config).connect(new StdioServerTransport());
// stdout carries the MCP protocol, so log to stderr only.
console.error(`gomining-hub MCP running (token ${config.client.hasToken ? 'configured' : 'not set'})`);
