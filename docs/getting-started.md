# Getting Started

## Prerequisites

- Node.js 20+ (tested on 20.x and 22.x)
- Docker (for integration tests)

## Installation

```bash
git clone https://github.com/steveramos21/ai-dba.git
cd ai-dba
npm install
npm run build
```

## Configuration

Copy the example config and edit with your credentials:

```bash
cp config.yaml.example config.yaml
```

```yaml
engines:
  my-mysql:
    type: mysql
    url: mysql://root:password@127.0.0.1:3306/mydb

  my-postgres:
    type: postgres
    url: postgresql://user:password@127.0.0.1:5432/mydb

  my-sqlserver:
    type: sqlserver
    url: sqlserver://sa:password@127.0.0.1:1433/mydb

  my-oracle:
    type: oracle
    url: oracle://user:password@127.0.0.1:1521/XEPDB1

  my-mongo:
    type: mongodb
    url: mongodb://user:password@127.0.0.1:27017/mydb?authSource=admin
```

## First Connection

### Option A: Config file

```bash
npm run repl
```

### Option B: Connection URL

```bash
node dist/index.js repl
# Then: connect mysql://root:password@127.0.0.1:3306/mydb
```

### Option C: One-off command

```bash
node dist/index.js --config config.yaml tables my-mysql
```

## Docker (for testing)

```bash
docker compose up -d
# 5 containers: MySQL 13306, PostgreSQL 15432, SQL Server 11433, Oracle 11521, MongoDB 12017
```

## Verify Installation

```bash
npm test          # 39 unit tests
npm run build     # TypeScript compiles
node dist/index.js --version  # Should print version
```