# Customer Feedback System

A Node.js, Express, and MongoDB application for collecting customer feedback and exploring satisfaction metrics through a browser dashboard.

## Features

- Customer registration and JWT-based login
- Feedback submission with a 1–5 satisfaction rating and category
- Feedback search and management endpoints
- Analytics API for total submissions, average rating, rating distribution, rating-based classification, feedback volume over time, and category counts
- Browser dashboard using Chart.js
- Jest/Supertest integration tests with an in-memory MongoDB test database

> The positive/neutral/negative dashboard groups are derived from ratings (4–5 positive, 3 neutral, 1–2 negative); they are not NLP sentiment analysis of feedback text.

## Requirements

- Node.js (LTS recommended) and npm
- A MongoDB connection string (local MongoDB or MongoDB Atlas)

## Setup

1. Open this folder in a terminal. It is the folder containing `package.json`.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create your local environment file by copying `.env.example` to `.env`.
4. Set `MONGODB_URI` to your own MongoDB connection string and replace `JWT_SECRET` with a long random secret. Do not commit `.env`.
5. Start the application:

   ```bash
   npm start
   ```

6. Open `http://localhost:3000` for the health endpoint and `http://localhost:3000/dashboard.html` for the dashboard.

## Tests

Run:

```bash
npm test
```

The tests use `mongodb-memory-server` and should not require your normal development database. On the first run, the test dependency may need to download a MongoDB binary.

## Project structure

```text
customer-feedback-system/
├── public/                 # Dashboard UI
├── src/config/             # Database connection
├── module/schema.js        # Mongoose models and indexes
├── tests/                  # API integration tests
├── backups/                # Runtime-generated backups (not committed)
├── server.js               # Express app and API routes
├── client-example.js       # Example API client
├── jest.config.js          # Jest configuration
├── .env.example            # Environment variable template
├── .gitignore
├── package.json
└── package-lock.json
```

## Configuration

- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: secret used to sign and verify authentication tokens

## Notes

- Never upload `.env`, database credentials, real customer data, or generated backup files to a public repository.
- Backup/restore and destructive operations should be restricted to trusted administrators before deployment.
- This repository is a learning/portfolio project; review security and deployment settings before exposing it publicly.
