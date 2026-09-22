# WhatsApp Fintech Bot (Nigeria)

Production-oriented WhatsApp banking bot: wallet, funding, airtime, data, bank transfers.

## Stack

- Node.js 20+, TypeScript, Express
- PostgreSQL + Prisma
- WhatsApp Cloud API
- Paystack (payments + transfers)
- VTPass (airtime + data)

## Money model

All amounts are **integer kobo** (`BigInt`). ₦1,000 = `100000` kobo. No floating-point balances.

## Setup

```bash
cp .env.example .env
# fill DATABASE_URL, WhatsApp, Paystack, VTPass secrets

npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev