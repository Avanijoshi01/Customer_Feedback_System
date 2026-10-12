import mongoose from 'mongoose';

const CustomerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    timeStamp: { type: Date, default: Date.now },
});

CustomerSchema.index({ email: 1 }, { unique: true });
CustomerSchema.index({ timeStamp: -1 });
CustomerSchema.index({ name: 'text' });

// Never expose password in API responses
CustomerSchema.methods.toJSON = function () {
    const obj = this.toObject();
    delete obj.password;
    return obj;
};

const FeedbackSchema = new mongoose.Schema({
    customerEmail: {
        type: String,
        required: [true, 'Customer email is required'],
        ref: 'Customer',
    },
    message: {
        type: String,
        required: [true, 'Feedback message is required'],
        trim: true,
        minlength: [3, 'Message must be at least 3 characters long'],
        maxlength: [500, 'Message cannot exceed 500 characters'],
    },
    satisfaction: {
        type: Number,
        required: [true, 'Satisfaction rating is required'],
        min: [1, 'Rating must be at least 1'],
        max: [5, 'Rating cannot exceed 5'],
        validate: {
            validator: Number.isInteger,
            message: 'Rating must be a whole number',
        },
    },
    category: {
        type: String,
        enum: ['shipping', 'product', 'service', 'billing', 'other'],
        default: 'other',
    },
    createdAt: { type: Date, default: Date.now },
    timeStamp: { type: Date, default: Date.now },
});

FeedbackSchema.index({ timeStamp: -1 });
FeedbackSchema.index({ message: 'text' });
FeedbackSchema.index({ customerEmail: 1 });
FeedbackSchema.index({ satisfaction: 1 });
FeedbackSchema.index({ category: 1 });

const ResponseSchema = new mongoose.Schema({
    feedbackId: { type: mongoose.Schema.Types.ObjectId, ref: 'Feedback', required: true },
    responseMessage: { type: String, required: true },
    responder: { type: String },
    createdAt: { type: Date, default: Date.now },
});

ResponseSchema.index({ feedbackId: 1 });
ResponseSchema.index({ createdAt: -1 });
ResponseSchema.index({ responder: 1 });

export const Customer = mongoose.model('Customer', CustomerSchema);
export const Feedback = mongoose.model('Feedback', FeedbackSchema);
export const Response = mongoose.model('Response', ResponseSchema);
