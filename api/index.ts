import express from 'express';
import { mountAiBridge } from './_bridge.ts';

const app = express();
app.use(express.json({ limit: '15mb' }));
mountAiBridge(app);

export default app;
