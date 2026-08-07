const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3003;
const AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN;

app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['x-worker-token', 'Content-Type'],
    credentials: false,
}));

function auth(req, res, next) {
    if (!AUTH_TOKEN) return next();
    const token = req.headers['x-worker-token'] || req.query.token;
    if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

require('./lib/fs');

const clipsRouter = require('./routes/clips');
const segmentsRouter = require('./routes/segments');
const driveRouter = require('./routes/drive');
const verticalRouter = require('./routes/vertical');

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/clip', auth, clipsRouter);
app.use('/segment', auth, segmentsRouter);
app.use('/drive', auth, driveRouter);
app.use('/clip', auth, verticalRouter());

app.listen(PORT, () => {
    console.log(`Worker running on port ${PORT}`);
    if (!AUTH_TOKEN) console.warn('⚠️  WORKER_AUTH_TOKEN not set — API is unprotected!');
});