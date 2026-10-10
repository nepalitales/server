# Nepali Tales Admin API

Backend service for the Nepali Tales Admin Management Panel built on Cloudflare Workers and Hono v4 with MongoDB Atlas.

## Overview

This API powers the administrative management system for Nepali Tales, providing secure operations for:
- Admin authentication with secure HTTP-only cookies
- Menu category hierarchy and management
- Product catalog management with Cloudinary image upload and asset cleanup
- Dynamic order window configuration per day of the week
- Weekly recurring closure settings
- Specific holiday calendar management
- Health monitoring and system diagnostics

## Tech Stack

- Runtime: Cloudflare Workers
- Framework: Hono v4
- Database: MongoDB Atlas
- Validation: Zod
- Storage: Cloudinary (REST API via Web Crypto SHA-1)
- Security: Secure HTTP-only cookies, PBKDF2 password hashing (100,000 iterations), timingSafeEqual verification, SameSite Lax

## Environment Variables

Copy `.env.example` to `.env` or `.dev.vars` for local development:

```bash
cp .env.example .dev.vars
```

| Variable | Description | Required |
|---|---|---|
| MONGODB_URI | MongoDB Atlas connection string | Yes |
| MONGODB_DB_NAME | Target database name (default: nepali-tales) | No |
| SESSION_SECRET | Random secret for session signing (min 32 chars) | Yes |
| CORS_ORIGIN | Allowed origin for CORS (e.g. admin panel URL) | No |
| NODE_ENV | Environment mode (development / production) | No |
| CLOUDINARY_CLOUD_NAME | Cloudinary cloud identifier | Optional |
| CLOUDINARY_API_KEY | Cloudinary API key | Optional |
| CLOUDINARY_API_SECRET | Cloudinary API secret | Optional |

Note: Cloudflare Workers automatically reads `.dev.vars` during local execution (`wrangler dev`). Node/tsx scripts (e.g. database seeders) support both `.env` and `.dev.vars`.

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Seed Database

Run the database seed script to initialize indexes, default categories, initial products, and the primary admin account:

```bash
npm run seed
```

### 3. Start Development Server

```bash
npm run dev
```

The server will be available at `http://localhost:8787`.

## API Endpoints

All admin endpoints are prefixed with `/api/admin`. All routes except login strictly require an authenticated admin session via HTTP-only cookie.

All API responses follow a standardized JSON envelope:
- Success: `{ "success": true, ...data }`
- Error: `{ "success": false, "message": "Reason", "errors"?: { "field": "Error description" } }`

### Health
- `GET /api/admin/health` - Authenticated system status and diagnostics check

### Authentication
- `POST /api/admin/auth/login` - Admin authentication with email or phone + password
- `GET /api/admin/auth/me` - Retrieve current authenticated admin profile
- `POST /api/admin/auth/logout` - Invalidate all active sessions for current admin and clear auth cookie

### Categories
- `GET /api/admin/categories` - List all categories sorted by display order
- `GET /api/admin/categories/:categoryId` - Retrieve single category details by ID
- `POST /api/admin/categories` - Create new category with automatic slug generation
- `PATCH /api/admin/categories/:categoryId` - Update category name or display order (cascades slug changes to assigned products)
- `DELETE /api/admin/categories/:categoryId` - Delete category (protected against deletion when products are still assigned)

### Products
- `GET /api/admin/products` - List products with optional categoryId filter and pagination
- `GET /api/admin/products/:productId` - Retrieve single product details by ID
- `POST /api/admin/products` - Create new product (supports base64 image upload to Cloudinary)
- `PATCH /api/admin/products/:productId` - Update product details, pricing, category, availability, or image
- `DELETE /api/admin/products/:productId` - Delete product and permanently destroy associated Cloudinary asset

### Order Windows
- `GET /api/admin/order-windows` - List 7-day order availability configuration
- `PUT /api/admin/order-windows/:day` - Update daily order window configuration with non-overlapping validation

### Weekly Off
- `GET /api/admin/weekly-off` - Retrieve recurring closed days of the week
- `PUT /api/admin/weekly-off` - Replace recurring closed days schedule

### Holidays
- `GET /api/admin/holidays` - List all scheduled closure dates sorted ascending by date
- `POST /api/admin/holidays` - Add new holiday closure date
- `PATCH /api/admin/holidays/:holidayId` - Update holiday date or reason
- `DELETE /api/admin/holidays/:holidayId` - Delete scheduled holiday

## Architecture & Code Conventions

- Serverless MongoDB Pattern: Fresh client per request with automatic closure in middleware `finally` block to prevent isolate connection leaks
- Direct Collection Access: Type-safe collection references using `COLLECTIONS` constants and typed MongoDB collection calls
- Native Crypto Primitives: Web Crypto PBKDF2 for password derivation, Node crypto `timingSafeEqual` for constant-time comparisons, and native Buffer encoding
- Direct Module Imports: Clean dependency trees importing directly from `./config/app` and `./config/env` without barrel indirection

## Deployment

Deploy directly to Cloudflare Workers:

```bash
npx wrangler secret put MONGODB_URI
npx wrangler secret put SESSION_SECRET
npm run deploy
```
