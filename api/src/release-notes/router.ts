import { Router, type Request, type Response } from 'express';
import { generateReleaseNotes, type ReleaseNoteEntry } from './release-notes';

const router = Router();

router.get('/notes', (req: Request, res: Response) => {
  const version = typeof req.query.version === 'string' ? req.query.version : 'unreleased';
  const entries = (typeof req.query.entries === 'string' ? req.query.entries.split(',') : []) as string[];
  const notes = generateReleaseNotes(entries.map((entry) => ({ summary: entry })), version);
  res.json({ success: true, data: notes });
});

router.post('/notes', (req: Request, res: Response) => {
  const payload = req.body ?? {};
  const entries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(payload.changes) ? payload.changes : [];
  const version = typeof payload.version === 'string' ? payload.version : 'unreleased';
  const notes = generateReleaseNotes(entries as Array<ReleaseNoteEntry | string>, version);
  res.json({ success: true, data: notes });
});

export default router;
