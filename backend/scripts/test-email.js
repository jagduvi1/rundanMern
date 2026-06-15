// One-shot Resend test send. Usage:
//   node scripts/test-email.js you@example.com
// Reads RESEND_API_KEY + EMAIL_FROM from backend/.env. Until your domain is
// verified in Resend you can only send to your own Resend account email.
require('dotenv').config();

const email = require('../src/services/email');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node scripts/test-email.js <recipient@example.com>');
    process.exit(1);
  }
  if (!email.isEnabled()) {
    console.error('RESEND_API_KEY is not set in backend/.env — aborting.');
    process.exit(1);
  }

  console.log(`Sending test email to ${to} from "${process.env.EMAIL_FROM}" ...`);
  try {
    const res = await email.send({
      to,
      subject: 'Rundan — Resend test',
      html: email.wrapTemplate({
        title: 'It works! 🎉',
        intro: 'This is a test email from Rundan via Resend. If you can read this, transactional email is wired up correctly.',
      }),
      text: 'It works! This is a test email from Rundan via Resend.',
    });
    console.log('✅ Accepted by Resend. Message id:', res?.id || '(no id returned)');
  } catch (err) {
    console.error('❌ Send failed:', err?.message || err);
    process.exit(1);
  }
}

main();
