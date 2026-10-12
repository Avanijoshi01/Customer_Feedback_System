/**
 * feedback.test.js
 *
 * Integration tests for the Customer Feedback System.
 *
 * Strategy:
 *  - mongodb-memory-server provides an isolated in-memory MongoDB so no live DB is needed.
 *  - Mongoose connects to that URI before `app` is imported, which means the guarded
 *    connectDB() + app.listen() in server.js are NOT executed (import.meta.url !== process.argv[1]).
 *  - supertest drives HTTP requests against the Express app directly (no listen needed).
 *  - A Customer document + JWT token are created in beforeAll so authenticated routes work.
 *  - The Feedback collection is cleared between test groups via beforeEach.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import supertest from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// ── Environment setup (must happen before server.js is imported) ──────────────
process.env.JWT_SECRET = 'test-secret-key-for-jest';
process.env.MONGODB_URI = 'placeholder'; // overridden in beforeAll

let mongod;
let request;
let token;
const TEST_EMAIL = 'test@example.com';
const TEST_PASS  = 'password123';

// We import app lazily after Mongoose is connected
let app;
let Customer;
let Feedback;

// ── Global setup / teardown ───────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Start in-memory MongoDB
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  // 2. Connect Mongoose before importing app (so connectDB guard is bypassed)
  await mongoose.connect(uri);

  // 3. Import app and models (now that Mongoose is already connected)
  const serverModule = await import('../server.js');
  app = serverModule.app;

  const schemaModule = await import('../module/schema.js');
  Customer = schemaModule.Customer;
  Feedback = schemaModule.Feedback;

  // 4. Create a test customer
  const hashed = await bcrypt.hash(TEST_PASS, 10);
  await Customer.create({ name: 'Test User', email: TEST_EMAIL, password: hashed });

  // 5. Sign a JWT for that customer
  token = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), email: TEST_EMAIL }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // 6. Create supertest agent
  request = supertest(app);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Clear feedback between test groups so they are fully isolated
  await Feedback.deleteMany({});
});

// ── Helper ────────────────────────────────────────────────────────────────────

function authHeader() {
  return { Authorization: `Bearer ${token}` };
}

async function postFeedback(body) {
  return request.post('/customers/feedback').set(authHeader()).send(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Empty database
// ─────────────────────────────────────────────────────────────────────────────

describe('Empty database', () => {
  test('GET /api/analytics returns all counts and percentages as zero', async () => {
    const res = await request.get('/api/analytics');

    expect(res.status).toBe(200);
    expect(res.body.totalSubmissions).toBe(0);
    expect(res.body.averageRating).toBe(0);

    // All five rating slots must be present with count 0
    expect(res.body.ratingDistribution).toHaveLength(5);
    res.body.ratingDistribution.forEach((slot) => {
      expect(slot.count).toBe(0);
    });

    // ratingClassification percentages all zero
    expect(res.body.ratingClassification.positive).toBe(0);
    expect(res.body.ratingClassification.neutral).toBe(0);
    expect(res.body.ratingClassification.negative).toBe(0);

    // Empty arrays for time series and categories
    expect(res.body.volumeOverTime).toEqual([]);
    expect(res.body.topCategories).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Rating distribution
// ─────────────────────────────────────────────────────────────────────────────

describe('Rating distribution', () => {
  test('submitting ratings 1–5 produces correct distribution and average', async () => {
    // Submit one feedback per rating
    for (const rating of [1, 2, 3, 4, 5]) {
      const res = await postFeedback({ message: `Rating ${rating} feedback`, satisfaction: rating });
      expect(res.status).toBe(201);
    }

    const res = await request.get('/api/analytics');
    expect(res.status).toBe(200);

    // Each rating count should be 1
    res.body.ratingDistribution.forEach((slot) => {
      expect(slot.count).toBe(1);
    });

    // Average of 1+2+3+4+5 = 3.00
    expect(res.body.averageRating).toBe(3.00);

    // ratingClassification: 2 negative (1,2), 1 neutral (3), 2 positive (4,5) → each 40/20%
    expect(res.body.ratingClassification.positive).toBeCloseTo(40, 0);
    expect(res.body.ratingClassification.neutral).toBeCloseTo(20, 0);
    expect(res.body.ratingClassification.negative).toBeCloseTo(40, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Missing required fields
// ─────────────────────────────────────────────────────────────────────────────

describe('Missing required fields', () => {
  test('POST without message returns HTTP 400', async () => {
    const res = await postFeedback({ satisfaction: 3 });
    expect(res.status).toBe(400);
  });

  test('POST without satisfaction returns HTTP 400', async () => {
    const res = await postFeedback({ message: 'Hello there' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Invalid category
// ─────────────────────────────────────────────────────────────────────────────

describe('Invalid category', () => {
  test('POST with unknown category returns HTTP 400 with error message', async () => {
    const res = await postFeedback({
      message: 'Test feedback',
      satisfaction: 3,
      category: 'invalid_value',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid category/i);
    // Error message should mention the allowed categories
    expect(res.body.error).toMatch(/shipping|product|service|billing|other/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Valid categories
// ─────────────────────────────────────────────────────────────────────────────

describe('Valid categories', () => {
  test('each allowed category is accepted and appears in analytics', async () => {
    const categories = ['shipping', 'product', 'service', 'billing', 'other'];

    for (const category of categories) {
      const res = await postFeedback({
        message: `Feedback about ${category}`,
        satisfaction: 3,
        category,
      });
      expect(res.status).toBe(201);
    }

    const res = await request.get('/api/analytics');
    expect(res.status).toBe(200);

    const { topCategories } = res.body;
    // All 5 categories should appear, each with count 1
    expect(topCategories).toHaveLength(5);

    for (const category of categories) {
      const entry = topCategories.find((c) => c.category === category);
      expect(entry).toBeDefined();
      expect(entry.count).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Date-based analytics
// ─────────────────────────────────────────────────────────────────────────────

describe('Date-based analytics', () => {
  test('records appear in correct date buckets in volumeOverTime', async () => {
    const date1 = new Date('2024-03-01T12:00:00.000Z');
    const date2 = new Date('2024-03-05T08:00:00.000Z');

    // Insert directly to control createdAt
    await Feedback.create([
      { customerEmail: TEST_EMAIL, message: 'Day one feedback', satisfaction: 4, createdAt: date1, timeStamp: date1 },
      { customerEmail: TEST_EMAIL, message: 'Day five feedback', satisfaction: 2, createdAt: date2, timeStamp: date2 },
    ]);

    const res = await request.get('/api/analytics');
    expect(res.status).toBe(200);

    const { volumeOverTime } = res.body;
    expect(volumeOverTime).toHaveLength(2);

    const bucket1 = volumeOverTime.find((v) => v.date === '2024-03-01');
    const bucket2 = volumeOverTime.find((v) => v.date === '2024-03-05');

    expect(bucket1).toBeDefined();
    expect(bucket1.count).toBe(1);

    expect(bucket2).toBeDefined();
    expect(bucket2.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Dashboard API error handling (browser-side JS — not testable with Jest alone)
// ─────────────────────────────────────────────────────────────────────────────

// The dashboard is a static HTML page with client-side JavaScript (dashboard.html).
// When the fetch('/api/analytics') call fails or returns a non-200 status, the JS
// catches the error and:
//   1. Hides the #loading element.
//   2. Sets errorEl.style.display = 'block' to reveal the #error-msg div.
//   3. Sets errorEl.textContent to: 'Failed to load analytics: ' + err.message
//      where err.message is 'Server returned <status> <statusText>'.
//
// This behaviour requires browser automation (e.g., Playwright) to test end-to-end
// because it involves DOM manipulation and the browser fetch() API in a real browser
// context. Jest + supertest cannot exercise browser-side DOM code.
// The error-handling path is implemented in public/dashboard.html's loadAnalytics().
//
// TODO: Add a Playwright test that:
//   1. Intercepts the /api/analytics request and returns a 500 response.
//   2. Waits for #error-msg to become visible.
//   3. Asserts that #error-msg contains 'Failed to load analytics: Server returned 500'.

describe('Dashboard error handling', () => {
  // Marked as todo — requires browser automation (Playwright) to execute.
  // The implementation in public/dashboard.html is complete; this test is the gap.
  test.todo('shows #error-msg with status text when /api/analytics returns non-200');
});
