# Deploying to AWS

> **Status: documented, not deployed.** Everything below follows from how the system is built and
> tested locally (two instances + Postgres + Redis via Docker Compose). It has not been run on AWS,
> and no AWS latency or cost figures are claimed anywhere in this repository.

## Target architecture

```
                 Route 53 (collab.example.com)
                              │
                  ACM certificate (TLS)
                              │
          Application Load Balancer (HTTPS :443)
             ├── /sync*      → target group "sync" (port 8787, WebSocket)
             └── /* (default) → target group "web"  (port 3000)
                              │
         Auto Scaling group: 2+ EC2 instances (private subnets, 2 AZs)
         each running two containers: sync server + web
                 │                          │
   RDS for PostgreSQL 17 (Multi-AZ)   ElastiCache for Redis 7
   op log + snapshots                 pub/sub fan-out between instances
```

Why this shape:

- **Any instance can serve any document** (DESIGN §8). The load balancer needs no sticky sessions
  or document routing.
- **Instances are stateless.** Durable state lives in RDS. Redis carries only best-effort fan-out,
  and losing it degrades propagation latency to the 2 s catch-up poll, not correctness. A single
  ElastiCache node is therefore acceptable.
- **RDS Multi-AZ** gives the op log synchronous standby replication and automated backups. The
  server already fails closed if Postgres is unavailable; clients keep unacked ops and resend.

## 1. Network and security groups

- A VPC with 2 public subnets (ALB) and 2 private subnets (EC2, RDS, ElastiCache) in two AZs, plus
  a NAT gateway for image pulls.
- Security groups:
  - `alb-sg`: inbound 443 from `0.0.0.0/0`.
  - `app-sg`: inbound 8787 and 3000 from `alb-sg` only.
  - `db-sg`: inbound 5432 from `app-sg` only.
  - `redis-sg`: inbound 6379 from `app-sg` only.

## 2. Data stores

```sh
aws rds create-db-instance \
  --db-instance-identifier collab-pg --engine postgres --engine-version 17 \
  --db-instance-class db.t4g.medium --allocated-storage 50 --storage-type gp3 \
  --multi-az --master-username collab --manage-master-user-password \
  --vpc-security-group-ids <db-sg> --db-subnet-group-name <private-subnets> \
  --backup-retention-period 7 --no-publicly-accessible

aws elasticache create-cache-cluster \
  --cache-cluster-id collab-redis --engine redis --engine-version 7.1 \
  --cache-node-type cache.t4g.small --num-cache-nodes 1 \
  --security-group-ids <redis-sg> --cache-subnet-group-name <private-subnets>
```

The schema is created by the server on startup (`PostgresStore.migrate`, idempotent
`CREATE ... IF NOT EXISTS`). Take the master password from Secrets Manager; never bake it into an
image.

## 3. Images

Build both images and push them to ECR:

```sh
aws ecr create-repository --repository-name collab-server
aws ecr create-repository --repository-name collab-web
docker build -f apps/server/Dockerfile -t <acct>.dkr.ecr.<region>.amazonaws.com/collab-server:<git-sha> .
docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_SYNC_URL=wss://collab.example.com/sync \
  -t <acct>.dkr.ecr.<region>.amazonaws.com/collab-web:<git-sha> .
docker push ...   # both
```

The web image inlines `NEXT_PUBLIC_SYNC_URL` at build time, so build it once per environment.

## 4. EC2 instances

Use a launch template on Amazon Linux 2023, `t4g.small` or larger (ARM: build the images with
`--platform linux/arm64`, or use x86 instances). The instance role needs ECR read and Secrets
Manager read. User data:

```sh
dnf install -y docker && systemctl enable --now docker
aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
DB_URL=$(aws secretsmanager get-secret-value --secret-id collab/database-url --query SecretString --output text)
docker run -d --restart=always --name sync -p 8787:8787 \
  -e DATABASE_URL="$DB_URL" -e REDIS_URL=redis://<elasticache-endpoint>:6379 \
  -e SNAPSHOT_EVERY=1000 -e LOG_LEVEL=info --stop-timeout 30 \
  <acct>.dkr.ecr.<region>.amazonaws.com/collab-server:<git-sha>
docker run -d --restart=always --name web -p 3000:3000 \
  <acct>.dkr.ecr.<region>.amazonaws.com/collab-web:<git-sha>
```

Put the launch template in an Auto Scaling group (min 2, across both AZs), registered with both
target groups.

## 5. Load balancer settings that matter for WebSockets

| Setting                     | Value          | Why                                                                                           |
| --------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Idle timeout                | 120 s          | Must exceed the server's 30 s ping interval, or idle editors get cut off                      |
| Health check (sync)         | `GET /healthz` | Returns 200 once the server listens                                                           |
| Health check (web)          | `GET /`        |                                                                                               |
| Deregistration delay (sync) | 30 s           | Gives `SIGTERM` time to close sockets with 1001 and drain writes; clients reconnect elsewhere |
| Stickiness                  | Off            | Not needed (multi-writer CRDT)                                                                |
| Listener                    | HTTPS 443, ACM | `wss://` is required on an `https://` page                                                    |

ALB supports the WebSocket upgrade natively on HTTP/1.1 listeners; no extra configuration is
needed.

## 6. Operations

- **Rolling deploys:** replace instances one at a time (ASG instance refresh). A replaced
  instance's clients reconnect with backoff and jitter, and resync by version vector. No acked op
  can be lost, because acks happen after the RDS commit.
- **Monitoring:** scrape `/metrics` (Prometheus text format) with CloudWatch Agent or Amazon
  Managed Prometheus. Alert on:
  - `sync_persist_errors_total` increasing;
  - `sync_server_latency_ms` p99;
  - `sync_slow_consumer_disconnects_total` rate;
  - `sync_catchup_ops_total` rising (Redis dropping messages).
- **Logs:** the server writes JSON lines to stdout and stderr; ship them with the awslogs driver.
- **Scaling signal:** per-instance CPU and `sync_connections`. Load testing showed Postgres commit
  latency as the first server-side limit (README), so watch RDS commit latency and IOPS before
  adding app instances.
- **Backups:** RDS automated backups plus snapshots. The `snapshots` table makes restores fast to
  serve, but the `ops` table is the authoritative history.

## 7. Before taking real traffic

These are known gaps; see README "Limitations".

- **Authentication and authorization.** Any client can open any document. Put an auth layer in
  front (for example, a signed token checked in `hello`), and bind replica ownership to the
  authenticated user.
- **Per-IP connection limits** at the ALB/WAF, in addition to the server's per-connection op
  rate limit.
- **Load-test from separate machines** against this topology. The numbers in the README come from
  a single laptop.
