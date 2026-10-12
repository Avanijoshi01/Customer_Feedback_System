import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import connectDB from './src/config/database.js';
import { Customer, Feedback, Response } from './module/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Remove the top-level connectDB call — moved to the guarded block below
// (connectDB is only called when running as the server entry point, not during tests)

// ─── Helpers ────────────────────────────────────────────────────────────────

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// ─── Middleware ──────────────────────────────────────────────────────────────

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication token required' });

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};

// Middleware: only allow the owner of a resource (matched by email) or skip for general listings
const authorizeOwnerOrSelf = (emailParam) => (req, res, next) => {
    if (req.user.email !== req.params[emailParam]) {
        return res.status(403).json({ error: 'Access denied' });
    }
    next();
};

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const customer = await Customer.findOne({ email });
        if (!customer) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const valid = await bcrypt.compare(password, customer.password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: customer._id, email: customer.email },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );
        res.json({ token });
    } catch (error) {
        next(error);
    }
});

// ─── Customers ───────────────────────────────────────────────────────────────

app.post('/customers', async (req, res, next) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'name, email, and password are required' });
        }

        const hashed = await bcrypt.hash(password, 12);
        const customer = new Customer({ name, email, password: hashed });
        await customer.save();

        // toJSON strips password (see schema)
        res.status(201).json(customer);
    } catch (error) {
        next(error);
    }
});

app.get('/customers', authenticateToken, async (req, res, next) => {
    try {
        // select('-password') as a belt-and-suspenders guard
        const customers = await Customer.find().select('-password');
        res.status(200).json(customers);
    } catch (error) {
        next(error);
    }
});

app.get('/customers/search', authenticateToken, async (req, res, next) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: 'query parameter is required' });
        const customers = await Customer.find({ name: { $regex: query, $options: 'i' } }).select('-password');
        res.status(200).json(customers);
    } catch (error) {
        next(error);
    }
});

app.get('/customers/indexes', authenticateToken, async (req, res, next) => {
    try {
        const indexes = await Customer.collection.getIndexes();
        res.status(200).json({ indexes, totalIndexes: Object.keys(indexes).length });
    } catch (error) {
        next(error);
    }
});

app.put('/customers/:id', authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid customer ID' });

        const { name, email } = req.body;

        const customer = await Customer.findById(id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        // Only allow the owner to update their own record
        if (String(customer._id) !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const updated = await Customer.findByIdAndUpdate(
            id,
            { ...(name && { name }), ...(email && { email }), timeStamp: new Date() },
            { new: true, runValidators: true }
        ).select('-password');

        res.status(200).json({ message: 'Customer updated successfully', customer: updated });
    } catch (error) {
        next(error);
    }
});

app.delete('/customers/delete-all', authenticateToken, async (req, res, next) => {
    try {
        const result = await Customer.deleteMany({});
        res.status(200).json({ message: 'All customers deleted', deletedCount: result.deletedCount });
    } catch (error) {
        next(error);
    }
});

app.delete('/customers/:id', authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid customer ID' });

        const customer = await Customer.findById(id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        if (String(customer._id) !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await Customer.findByIdAndDelete(id);
        res.status(200).json({ message: 'Customer deleted' });
    } catch (error) {
        next(error);
    }
});

// ─── Feedback ────────────────────────────────────────────────────────────────

const ALLOWED_CATEGORIES = ['shipping', 'product', 'service', 'billing', 'other'];

app.post('/customers/feedback', authenticateToken, async (req, res, next) => {
    try {
        const { message, satisfaction, category } = req.body;
        const email = req.user.email; // use authenticated user's email

        // Explicit category validation — invalid values are rejected, not silently defaulted
        if (category !== undefined && !ALLOWED_CATEGORIES.includes(category)) {
            return res.status(400).json({
                error: `Invalid category. Must be one of: ${ALLOWED_CATEGORIES.join(', ')}`,
            });
        }

        const customer = await Customer.findOne({ email });
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const feedback = new Feedback({ customerEmail: email, message, satisfaction, category });
        await feedback.save();

        res.status(201).json({
            message: 'Feedback submitted successfully',
            feedback: {
                ...feedback.toObject(),
                customer: { name: customer.name, email: customer.email },
            },
        });
    } catch (error) {
        next(error);
    }
});

app.get('/feedbacks', authenticateToken, async (req, res, next) => {
    try {
        const feedbacks = await Feedback.find().sort({ createdAt: -1 });

        const result = await Promise.all(
            feedbacks.map(async (fb) => {
                const customer = await Customer.findOne({ email: fb.customerEmail }).select('-password');
                return { ...fb.toObject(), customer: customer || null };
            })
        );

        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
});

app.get('/customers/:email/feedbacks', authenticateToken, authorizeOwnerOrSelf('email'), async (req, res, next) => {
    try {
        const { email } = req.params;

        const customer = await Customer.findOne({ email }).select('-password');
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const feedbacks = await Feedback.find({ customerEmail: email }).sort({ createdAt: -1 });

        res.status(200).json({ customer, feedbackCount: feedbacks.length, feedbacks });
    } catch (error) {
        next(error);
    }
});

app.put('/feedbacks/:id', authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid feedback ID' });

        const feedback = await Feedback.findById(id);
        if (!feedback) return res.status(404).json({ error: 'Feedback not found' });

        if (feedback.customerEmail !== req.user.email) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { message } = req.body;
        const updated = await Feedback.findByIdAndUpdate(
            id,
            { message },
            { new: true, runValidators: true }
        );
        res.status(200).json(updated);
    } catch (error) {
        next(error);
    }
});

app.delete('/feedbacks/:id', authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid feedback ID' });

        const feedback = await Feedback.findById(id);
        if (!feedback) return res.status(404).json({ error: 'Feedback not found' });

        if (feedback.customerEmail !== req.user.email) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await Feedback.findByIdAndDelete(id);
        res.status(200).json({ message: 'Feedback deleted' });
    } catch (error) {
        next(error);
    }
});

app.get('/feedbacks/indexes', authenticateToken, async (req, res, next) => {
    try {
        const indexes = await Feedback.collection.getIndexes();
        res.status(200).json({ indexes, totalIndexes: Object.keys(indexes).length });
    } catch (error) {
        next(error);
    }
});

app.post('/feedbacks/search', authenticateToken, async (req, res, next) => {
    try {
        const { message, minSatisfaction, maxSatisfaction, startDate, endDate } = req.body;

        const query = {};

        if (message) query.message = { $regex: message, $options: 'i' };

        if (minSatisfaction !== undefined || maxSatisfaction !== undefined) {
            const min = Number(minSatisfaction);
            const max = Number(maxSatisfaction);
            if (minSatisfaction !== undefined && (isNaN(min) || min < 1 || min > 5)) {
                return res.status(400).json({ error: 'minSatisfaction must be a number between 1 and 5' });
            }
            if (maxSatisfaction !== undefined && (isNaN(max) || max < 1 || max > 5)) {
                return res.status(400).json({ error: 'maxSatisfaction must be a number between 1 and 5' });
            }
            query.satisfaction = {};
            if (minSatisfaction !== undefined) query.satisfaction.$gte = min;
            if (maxSatisfaction !== undefined) query.satisfaction.$lte = max;
        }

        if (startDate || endDate) {
            const start = startDate ? new Date(startDate) : null;
            const end = endDate ? new Date(endDate) : null;
            if (start && isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid startDate' });
            if (end && isNaN(end.getTime())) return res.status(400).json({ error: 'Invalid endDate' });
            query.createdAt = {};
            if (start) query.createdAt.$gte = start;
            if (end) query.createdAt.$lte = end;
        }

        const feedbacks = await Feedback.find(query).sort({ createdAt: -1 });
        res.status(200).json(feedbacks);
    } catch (error) {
        next(error);
    }
});

// ─── Responses ───────────────────────────────────────────────────────────────

app.post('/responses', authenticateToken, async (req, res, next) => {
    try {
        const { feedbackId, responseMessage, responder } = req.body;
        if (!feedbackId || !isValidObjectId(feedbackId)) {
            return res.status(400).json({ error: 'Valid feedbackId is required' });
        }
        const exists = await Feedback.findById(feedbackId);
        if (!exists) return res.status(404).json({ error: 'Feedback not found' });

        const response = new Response({ feedbackId, responseMessage, responder });
        await response.save();
        res.status(201).json({ message: 'Response created successfully', response });
    } catch (error) {
        next(error);
    }
});

app.get('/responses', authenticateToken, async (req, res, next) => {
    try {
        const responses = await Response.find().populate('feedbackId');
        res.status(200).json(responses);
    } catch (error) {
        next(error);
    }
});

app.get('/responses/search', authenticateToken, async (req, res, next) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: 'query parameter is required' });
        const responses = await Response.find({ responseMessage: { $regex: query, $options: 'i' } });
        res.status(200).json(responses);
    } catch (error) {
        next(error);
    }
});

app.put('/responses/:id', authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid response ID' });

        const existing = await Response.findById(id);
        if (!existing) return res.status(404).json({ error: 'Response not found' });

        const { responseMessage, responder } = req.body;
        const updated = await Response.findByIdAndUpdate(
            id,
            { responseMessage, responder },
            { new: true, runValidators: true }
        );
        res.status(200).json(updated);
    } catch (error) {
        next(error);
    }
});

app.delete('/responses/:id', authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid response ID' });

        const existing = await Response.findById(id);
        if (!existing) return res.status(404).json({ error: 'Response not found' });

        await Response.findByIdAndDelete(id);
        res.status(200).json({ message: 'Response deleted' });
    } catch (error) {
        next(error);
    }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

// GET /api/analytics — public, no auth required
app.get('/api/analytics', async (req, res, next) => {
    try {
        const [
            totalResult,
            avgResult,
            ratingDistResult,
            sentimentResult,
            volumeResult,
            categoryResult,
        ] = await Promise.all([
            // a. Total submissions
            Feedback.countDocuments(),

            // b. Average rating
            Feedback.aggregate([
                { $group: { _id: null, avg: { $avg: '$satisfaction' } } },
            ]),

            // c. Rating distribution — one bucket per integer 1–5
            Feedback.aggregate([
                { $group: { _id: '$satisfaction', count: { $sum: 1 } } },
                { $sort: { _id: 1 } },
            ]),

            // d. Sentiment percentages
            Feedback.aggregate([
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        positive: {
                            $sum: {
                                $cond: [{ $gte: ['$satisfaction', 4] }, 1, 0],
                            },
                        },
                        neutral: {
                            $sum: {
                                $cond: [{ $eq: ['$satisfaction', 3] }, 1, 0],
                            },
                        },
                        negative: {
                            $sum: {
                                $cond: [{ $lte: ['$satisfaction', 2] }, 1, 0],
                            },
                        },
                    },
                },
            ]),

            // e. Volume over time — grouped by calendar day (UTC)
            Feedback.aggregate([
                {
                    $group: {
                        _id: {
                            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
                        },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]),

            // f. Top categories
            Feedback.aggregate([
                { $group: { _id: '$category', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 },
            ]),
        ]);

        // --- Shape the response ---

        const totalSubmissions = totalResult;

        // Early return for empty database — avoids division-by-zero in ratingClassification
        if (totalSubmissions === 0) {
            return res.status(200).json({
                totalSubmissions: 0,
                averageRating: 0,
                ratingDistribution: [1, 2, 3, 4, 5].map((n) => ({ rating: n, count: 0 })),
                ratingClassification: { positive: 0, neutral: 0, negative: 0 },
                volumeOverTime: [],
                topCategories: [],
            });
        }

        const averageRating =
            avgResult.length > 0
                ? Math.round(avgResult[0].avg * 100) / 100
                : 0;

        // Ensure all 5 rating slots are present even if no data exists for that value
        const ratingMap = Object.fromEntries(
            ratingDistResult.map((r) => [r._id, r.count])
        );
        const ratingDistribution = [1, 2, 3, 4, 5].map((n) => ({
            rating: n,
            count: ratingMap[n] || 0,
        }));

        // ratingClassification: rating-based tiers (4–5 positive, 3 neutral, 1–2 negative)
        // This is NOT NLP sentiment — it is a satisfaction rating classification.
        const sentimentRaw = sentimentResult[0] || { total: 0, positive: 0, neutral: 0, negative: 0 };
        const ratingClassification = {
            positive: Math.round((sentimentRaw.positive / totalSubmissions) * 10000) / 100,
            neutral:  Math.round((sentimentRaw.neutral  / totalSubmissions) * 10000) / 100,
            negative: Math.round((sentimentRaw.negative / totalSubmissions) * 10000) / 100,
        };

        const volumeOverTime = volumeResult.map((v) => ({
            date: v._id,
            count: v.count,
        }));

        const topCategories = categoryResult.map((c) => ({
            category: c._id || 'other',
            count: c.count,
        }));

        res.status(200).json({
            totalSubmissions,
            averageRating,
            ratingDistribution,
            ratingClassification,
            volumeOverTime,
            topCategories,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/overall-rating', authenticateToken, async (req, res, next) => {
    try {
        const result = await Feedback.aggregate([
            { $group: { _id: null, averageRating: { $avg: '$satisfaction' } } },
        ]);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
});

// ─── Backup / Restore ────────────────────────────────────────────────────────

app.post('/backup', authenticateToken, async (req, res, next) => {
    try {
        const [customers, feedbacks, responses] = await Promise.all([
            Customer.find().select('-password'),
            Feedback.find(),
            Response.find(),
        ]);

        const backup = { timestamp: new Date(), data: { customers, feedbacks, responses } };
        const backupDir = './backups';
        await fs.mkdir(backupDir, { recursive: true });
        const filename = `backup-${Date.now()}.json`;
        await fs.writeFile(path.join(backupDir, filename), JSON.stringify(backup, null, 2));

        res.status(200).json({ message: 'Backup created successfully', filename });
    } catch (error) {
        next(error);
    }
});

app.get('/backups', authenticateToken, async (req, res, next) => {
    try {
        const files = await fs.readdir('./backups');
        res.status(200).json(files.filter((f) => f.endsWith('.json')));
    } catch (error) {
        next(error);
    }
});

app.get('/backup/:filename', authenticateToken, async (req, res, next) => {
    try {
        const backupPath = path.join('./backups', path.basename(req.params.filename));
        const content = JSON.parse(await fs.readFile(backupPath, 'utf-8'));
        res.status(200).json({
            timestamp: content.timestamp,
            stats: {
                customers: content.data.customers.length,
                feedbacks: content.data.feedbacks.length,
                responses: content.data.responses.length,
            },
            data: content.data,
        });
    } catch (error) {
        next(error);
    }
});

app.post('/restore/:filename', authenticateToken, async (req, res, next) => {
    try {
        const backupPath = path.join('./backups', path.basename(req.params.filename));
        const backupData = JSON.parse(await fs.readFile(backupPath, 'utf-8'));

        await Promise.all([Customer.deleteMany({}), Feedback.deleteMany({}), Response.deleteMany({})]);

        if (backupData.data.customers.length) await Customer.insertMany(backupData.data.customers);
        if (backupData.data.feedbacks.length) await Feedback.insertMany(backupData.data.feedbacks);
        if (backupData.data.responses.length) await Response.insertMany(backupData.data.responses);

        res.status(200).json({
            message: 'Restore completed successfully',
            stats: {
                customers: backupData.data.customers.length,
                feedbacks: backupData.data.feedbacks.length,
                responses: backupData.data.responses.length,
            },
        });
    } catch (error) {
        next(error);
    }
});

app.delete('/backup/:filename', authenticateToken, async (req, res, next) => {
    try {
        await fs.unlink(path.join('./backups', path.basename(req.params.filename)));
        res.status(200).json({ message: 'Backup deleted successfully' });
    } catch (error) {
        next(error);
    }
});

// ─── Change Stream ───────────────────────────────────────────────────────────

app.put('/changestream/feedback/:id', authenticateToken, async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid feedback ID' });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const pipeline = [
            {
                $match: {
                    $and: [
                        { 'documentKey._id': new mongoose.Types.ObjectId(id) },
                        { operationType: { $in: ['update', 'replace', 'delete'] } },
                    ],
                },
            },
        ];

        const changeStream = Feedback.watch(pipeline, { fullDocument: 'updateLookup' });

        changeStream.on('change', (change) => {
            res.write(
                `data: ${JSON.stringify({
                    operationType: change.operationType,
                    timestamp: new Date(),
                    documentId: change.documentKey._id,
                    changes: change.updateDescription?.updatedFields || change.fullDocument,
                })}\n\n`
            );
        });

        req.on('close', () => { changeStream.close(); res.end(); });
        changeStream.on('error', () => {
            res.write(`data: ${JSON.stringify({ error: 'Stream error occurred' })}\n\n`);
        });
    } catch (error) {
        next(error);
    }
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.status(200).json({ status: 'ok' }));

// ─── Global error handler ────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);

    // Mongoose validation error
    if (err.name === 'ValidationError') {
        return res.status(400).json({ error: 'Validation failed', details: err.message });
    }
    // Duplicate key
    if (err.code === 11000) {
        return res.status(409).json({ error: 'Duplicate entry', details: err.message });
    }

    res.status(500).json({ error: 'Internal server error' });
});

// Export app for testing — connectDB and listen only run as the entry point
export { app };

// Only start the server when this file is executed directly (not imported by tests)
const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
    connectDB();
    app.listen(3000, () => console.log('Server running on port 3000'));
}
