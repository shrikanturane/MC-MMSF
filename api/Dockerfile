# MCMF API — NestJS + Prisma
FROM node:20

# iputils-ping for ICMP up/down checks (MonitorsService); nmap for external VAPT scanning
# (vulnerabilities via the vulners NSE script, misconfigurations + threats from exposed services).
# nsis (makensis) builds the Windows endpoint-agent installer (.exe) on the server.
# postgresql-client-16 must match the server major version (pg_dump refuses a newer server),
# so pull it from the official PGDG apt repo rather than Debian's older default client.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping nmap nsis curl ca-certificates gnupg openssl openssh-client \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (full node image already has openssl for the Prisma engine)
COPY package.json ./
RUN npm install

# Prisma schema first so generate is cached
COPY prisma ./prisma
RUN npx prisma generate

# App source
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

EXPOSE 4000

# On boot: apply schema, seed if empty, then serve.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npx ts-node --transpile-only prisma/seed.ts && node dist/main.js"]
