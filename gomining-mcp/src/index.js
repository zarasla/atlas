#!/usr/bin/env node
// Entry point: runs the GoMining MCP server over stdio.
//
// Environment:
//   GOMINING_TOKEN         bearer token from app.gomining.com, for account endpoints (optional)
//   GOMINING_BASE_URL      API base URL (default https://api.gomining.com/api)
//   GOMINING_ALLOW_WRITES  set to 1 to allow PUT/PATCH/DELETE through gomining_api_request

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_BASE_URL, GoMiningClient } from './client.js';
import { createServer } from './server.js';

const client = new GoMiningClient({
  baseUrl: process.env.GOMINING_BASE_URL || DEFAULT_BASE_URL,
  token: process.env.GOMINING_TOKEN?.replace(/^Bearer\s+/i, '').trim(),
});
const server = createServer(client, { allowWrites: process.env.GOMINING_ALLOW_WRITES === '1' });

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol, so log to stderr only.
console.error(`gomining-mcp running (token ${client.hasToken ? 'configured' : 'not set'})`);
