// Creates a super admin (or resets an existing one). The password is typed in the terminal.
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { email as emailSchema, password as passwordSchema, text } from '../src/lib/schemas.js';
import { hashPassword } from '../src/lib/security.js';
import { audit } from '../src/lib/tx.js';
import { LoginAttempt, Session, User } from '../src/models/index.js';
import { createPrompt } from './prompt.js';

const prompt = createPrompt();
const valid = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0].message);
  return result.data;
};

try {
  const name = valid(text(80).min(2, 'Enter your name'), await prompt.ask('Name: '));
  const email = valid(emailSchema, await prompt.ask('Email: '));
  const password = valid(passwordSchema, await prompt.ask('Password (hidden, 8+ characters with letters and numbers): ', true));
  if (await prompt.ask('Repeat password: ', true) !== password) throw new Error('The passwords do not match.');
  await connectDB();
  const existing = await User.findOne({ email });
  if (existing && (await prompt.ask(`${email} already exists. Make it an active super admin with this password? (yes/no) `)) !== 'yes') throw new Error('Cancelled');
  const user = existing || new User({ email });
  user.set({ name, role: 'super_admin', status: 'active', passwordHash: await hashPassword(password), mustChangePassword: false, sessionVersion: (user.sessionVersion || 0) + 1 });
  await user.save();
  await Session.deleteMany({ userId: user._id });
  await LoginAttempt.deleteMany({});
  await audit({ name: 'create-admin script' }, existing ? 'Reset super admin' : 'Created super admin', 'users', user._id);
  console.log(`Super admin ready: ${email}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  prompt.close();
  await mongoose.disconnect();
}
