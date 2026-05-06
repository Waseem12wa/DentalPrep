#!/bin/bash
# Build script for Render deployment

echo "Installing backend dependencies..."
cd backend
npm install

echo "Migrating specific static files to GridFS..."
npm run migrate-files

echo "Build complete!"
