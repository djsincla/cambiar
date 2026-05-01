import { Router } from 'express';
import { findUserByIcalToken, buildIcalFeed } from '../services/icalFeed.js';

const router = Router();

// Public — no requireAuth. The token IS the credential. Calendar apps fetch
// this on a schedule and have no way to log in.
router.get('/upcoming.ics', (req, res) => {
  const token = String(req.query.token ?? '');
  const user = findUserByIcalToken(token);
  if (!user || !user.active) {
    res.set('Content-Type', 'text/plain');
    return res.status(401).send('invalid or expired token');
  }
  const body = buildIcalFeed();
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="cambiar-upcoming.ics"',
    // Calendar apps poll periodically; let them cache for a few minutes.
    'Cache-Control': 'private, max-age=300',
  });
  res.status(200).send(body);
});

export default router;
