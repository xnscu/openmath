#!/bin/bash

# OpenMath Deployment Script
# This script handles building and deploying the Cloudflare Worker

set -e

echo "🚀 Starting OpenMath deployment..."

# Step 1: Build the frontend
echo "📦 Building frontend with Vite..."
npm run build

# Step 2: Initialize D1 database (if not already done)
echo "🗄️ Initializing D1 database..."
if ! wrangler d1 execute openmath --command "SELECT name FROM sqlite_master WHERE type='table' AND name='exams'" 2>/dev/null | grep -q "exams"; then
    echo "📝 Creating database tables..."
    wrangler d1 execute openmath --file=schema.sql
else
    echo "✅ Database already initialized"
fi

# Step 3: Deploy the worker
echo "☁️ Deploying to Cloudflare Workers..."
wrangler deploy

echo "✅ Deployment complete!"
echo ""
echo "📌 Your app is now live at your Cloudflare Worker URL"
echo "📌 API endpoints available at /api/*"
