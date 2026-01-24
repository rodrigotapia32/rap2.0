import { NextResponse } from 'next/server';

export async function GET() {
  const TURN_SECRET = 'c94829d333246d94536a2c2df3e8a71ee9d709f6ac50cc7a75c355b863a82575';
  const TURN_SERVER = '159.89.54.229:3478';

  // Generate ephemeral credentials valid for 24 hours
  const timestamp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const username = `${timestamp}:rap2.0`;

  // HMAC-SHA1 using Node.js crypto
  const { createHmac } = await import('crypto');
  const hmac = createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');

  return NextResponse.json({
    username,
    credential,
    urls: [
      `stun:${TURN_SERVER}`,
      `turn:${TURN_SERVER}`,
    ],
    ttl: 86400,
  });
}
