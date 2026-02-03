# DentalPrep Backend

## Setup

1. Install dependencies:

   npm install

2. Create a .env file in this folder (see .env.example).

3. Run the server:

   npm run dev

## API

- POST /api/signup
- POST /api/login
- GET /api/user/profile (requires Authorization: Bearer <token>)
- GET /api/progress (requires auth)
- POST /api/progress (requires auth)
- GET /api/health
