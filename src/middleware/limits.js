import rateLimit from 'express-rate-limit';

const make = (windowMin, max, message, keyGenerator) => rateLimit({
  windowMs: windowMin * 60e3, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: message }, ...(keyGenerator ? { keyGenerator } : {})
});

export const apiLimiter = make(15, 600, 'Too many requests. Please slow down.');
export const loginLimiter = make(15, 20, 'Too many sign-in attempts. Try again in a few minutes.');
export const registerLimiter = make(60, 10, 'Too many sign-ups from this network. Try again later.');
export const mfaLimiter = make(15, 15, 'Too many verification attempts. Try again in a few minutes.');
export const uploadLimiter = make(60, 40, 'Upload limit reached. Try again in an hour.', (req) => req.auth?.user.id ?? 'anon');
export const trainingLimiter = make(60, 20, 'Too many training requests.', (req) => req.auth?.user.id ?? 'anon');
