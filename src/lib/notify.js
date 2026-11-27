import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const emailReady = () => Boolean(env.smtpUrl && env.mailFrom);
/** In development the code is printed in the server terminal when email is not set up. */
export const canSendCodes = () => emailReady() || env.nodeEnv !== 'production';

export const outbox = []; // used by the tests

export async function sendResetCode(user, code) {
  if (env.nodeEnv === 'test') return outbox.push({ email: user.email, code });
  if (!emailReady()) return console.log(`[development only] Password reset code for ${user.email}: ${code}`);
  await nodemailer.createTransport(env.smtpUrl).sendMail({
    from: env.mailFrom,
    to: user.email,
    subject: 'Your Bondhu Sanchay password reset code',
    text: `Your code is ${code}. It is valid for 5 minutes.\nIf you did not request this, ignore this email.`,
  });
}
