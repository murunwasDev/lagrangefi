---
name: db
description: Run a SQL query against the lagrangefi PostgreSQL database on the test server via SSH + kubectl exec
user-invocable: true
allowed-tools: Bash(ssh *)
---

# DB Query Skill

Run SQL against the lagrangefi test database.

## Connection path
SSH → root@187.124.224.48 → kubectl exec into postgres-0 pod (test namespace) → psql

Credentials are available as environment variables: $DB_USER, $DB_PASSWORD, $DB_NAME.

## Schema reference
See [schema.md](schema.md) for all tables and columns.

## Instructions

The user's query or request is: $ARGUMENTS

1. Determine the appropriate SQL for the user's request (refer to schema.md).

2. Run it via this SSH command pattern:
```bash
ssh root@187.124.224.48 "kubectl -n test exec postgres-0 -- env PGPASSWORD='$DB_PASSWORD' psql -U '$DB_USER' -d '$DB_NAME' -c \"<SQL HERE>\""
```

3. Return the full output and explain the results clearly.
