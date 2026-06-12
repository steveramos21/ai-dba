# AI-DBA - Universal Database Copilot

## Overview

AI-DBA is a natural language interface that speaks every major database engine (MySQL, PostgreSQL, SQL Server, Oracle, MongoDB) with a rollback-first philosophy.

This repository contains **Server 2 (DBA Diagnostics)** - a read-only diagnostic MCP server providing tools like blocking chains, replication status, missing indexes, etc.

## Getting Started

### Prerequisites

- Node.js >= 18
- Docker (optional, for test databases)

### Installation

```bash
npm install
```

### Configuration

Copy `config.yaml.example` to `config.yaml` and fill in your database connection details.

### Running the MCP Server

```bash
npm start
# or
node dist/index.js
```

The server will expose MCP tools over stdio for use by AI agents (Hermes, Claude Code, Codex, etc.).

## Development

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

## Available Tools (Planned)

- `blocking-chains` - Current blocking/wait scenarios
- `replication-status` - Replica lag and health
- `missing-indexes` - Index recommendations
- `memory-usage` - Buffer pool / memory statistics
- `backup-status` - Backup health and schedule

## License

MIT
